import * as vscode from "vscode";
import { ChatMessage, fetchAction, streamChat, ToolCall } from "./api";
import {
  applyTodoAction,
  executeTool,
  FILE_READ_TOOLS,
  formatTodoMarkdown,
  READ_ONLY_TOOLS,
  TodoItem,
  TOOL_SPECS,
} from "./chatTools";
import { loadConfig } from "./config";
import { buildContextBlock } from "./context";
import { parseFileEdits, ProposedEdit } from "./edits";
import {
  findRelevantSymbols,
  formatSymbolsBlock,
  loadIndex,
  WorkspaceIndex,
} from "./indexer";
import { buildEditSystemPrompt, buildFixSystemPrompt } from "./prompts";
import { extractCode } from "./utils";
/* eslint-disable @typescript-eslint/no-restricted-imports */
import * as fs from "fs";
import * as path from "path";
/* eslint-enable @typescript-eslint/no-restricted-imports */

// Costanti di configurazione locali per evitare dipendenze circolari o accoppiamento stretto
const SUMMARY_FILENAME = ".pm_context_summary.json";
const TODO_FILENAME = ".pm_todo_state.json";
const MAX_CONTEXT_CHARS = 3000; // Soglia simile a quella usata in chatPanel.ts per inject file
const MAX_REFERENCE_CHARS = 3000; // Cap per ogni file referenziato con #file
// Alzato da 10: con edit-file ogni correzione applicata è tipicamente un round a sé
// (lettura a blocchi 3-4 round + N edit + verifiche). Il vero anti-loop non è più
// questo numero ma il rilevatore di chiamate duplicate nel loop qui sotto; e al
// raggiungimento del cap il turno si chiude con un round di riepilogo, non a metà.
const MAX_TOOL_ROUNDS = 30;
const MAX_FILE_READS_PER_TURN = 12; // Cap separato sulle letture file (current-file/read-file), per non saturare i 131072 token di contesto con letture a raffica

/**
 * Istruzioni su come applicare le modifiche ai file.
 * Via primaria: il tool edit-file (search/replace mirato) — il modello applica
 * da solo, senza riscrivere file interi in chat (che con file lunghi sfora il
 * budget di token e lascia fence troncati inapplicabili).
 * Fallback: il formato marker ```linguaggio:percorso per PROPORRE una modifica
 * che l'utente applica con un click — riusa il contratto di parseFileEdits/edits.ts
 * (file COMPLETO, niente placeholder). Iniettata sempre nel system prompt.
 */
const EDIT_FORMAT_INSTRUCTION = `

--- APPLYING CODE CHANGES ---
When the user asks you to fix, change, or refactor code, APPLY the changes yourself with the edit-file tool — do NOT paste the modified code into the chat. Workflow: read the file first (current-file or read-file), then call edit-file once per change with the exact fragment to replace (old_string, whitespace included) and its replacement (new_string). Prefer several small, targeted edit-file calls over rewriting a whole file. After applying, briefly summarize what you changed.

--- PROPOSED EDIT FORMAT (fallback only) ---
Only when the user wants to REVIEW a suggestion without applying it, you can propose a one-click-applicable change by opening the code block with:
\`\`\`<language>:<relative/path/to/file.ext>

Rules, no exceptions:
1. Only use this format when you know the file's FULL current content (you read it via current-file or read-file in this conversation, or it's shown in the context above).
2. The code block must contain the ENTIRE file content after your change — never partial snippets, never placeholders like "// rest unchanged" or "// other methods". A partial file would overwrite and destroy the rest of the file when applied.
3. If you don't have the full file content, or the user just wants to see example code (not apply it to a specific file), use a plain \`\`\`<language> block with no path — do NOT guess a path.
4. Use forward slashes and a path relative to the workspace root (e.g. ResaBackend/Controllers/QuoteController.cs).`;

/**
 * Carica il summary dalla disk se presente.
 */
function loadSessionSummary(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;

  const filePath = path.join(folders[0].uri.fsPath, SUMMARY_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as { summary?: string };
    return data.summary ?? null;
  } catch {
    return null;
  }
}

/**
 * Carica lo stato della todo list da disco, se presente. Persistere su file
 * (invece che solo in memoria per la durata di handleChatRequest) permette al
 * piano di sopravvivere tra un messaggio e l'altro della stessa conversazione —
 * senza questo, un piano a più step creato dal modello sparirebbe non appena
 * l'utente scrive un altro messaggio (es. "sì, procedi"), perché ogni chiamata
 * a handleChatRequest partirebbe da zero.
 */
function loadTodoState(): TodoItem[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];

  const filePath = path.join(folders[0].uri.fsPath, TODO_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Salva lo stato della todo list su disco. Non blocca il flusso se fallisce (solo log). */
function saveTodoState(items: TodoItem[]): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;

  const filePath = path.join(folders[0].uri.fsPath, TODO_FILENAME);
  try {
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2), "utf8");
  } catch (e) {
    console.error("[PM Chat] Impossibile salvare lo stato del piano:", e);
  }
}

/**
 * Carica il Workspace Index da disco (se presente).
 */
function loadWorkspaceIndex(): WorkspaceIndex | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return loadIndex(folders[0].uri.fsPath);
}

/**
 * Verifica se un URI è già incluso nel contesto (file attivo o gemello).
 */
function isAlreadyIncluded(
  uri: vscode.Uri,
  activeBase: string | null,
): boolean {
  if (!activeBase) return false;
  return uri.fsPath.startsWith(activeBase.slice(0, -1));
}

/**
 * Estrae il nome del file dal path.
 */
function getFilename(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.fsPath;
}

/**
 * Estrae l'estensione dal nome del file.
 */
function getExtension(filename: string): string | undefined {
  const parts = filename.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : undefined;
}

/**
 * Sanitizza il testo della history rimuovendo pattern di tool-call testuali
 * malformati che potrebbero essere rimasti da versioni precedenti dell'estensione
 * (XML <tool:...>, placeholder #tool:...). Difensivo: con il tool calling nativo
 * questi pattern non dovrebbero più generarsi, ma la history di sessioni vecchie
 * potrebbe ancora contenerli.
 */
function sanitizeHistoryText(text: string): string {
  return text
    .replace(/#tool:[\w\s]+(—[^\n]*)?/g, "")
    .replace(/<tool:[\w.]+>.*?<\/tool:[\w.]+>/gs, "")
    .trim();
}

/**
 * Costruisce il contesto automatico per la chat.
 * Include: File attivo, file gemello (se esiste), simboli rilevanti dall'indice.
 */
async function buildAutoContext(
  prompt: string,
  workspaceIndex: WorkspaceIndex | null,
): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "";

  const document = editor.document;

  let contextBlock = "";
  try {
    const selectionRange = editor.selection.isEmpty
      ? new vscode.Range(0, 0, document.lineCount, 0)
      : editor.selection;

    const rawContext = await buildContextBlock(
      document,
      selectionRange,
      true,
      false,
    );
    if (rawContext && rawContext.length > MAX_CONTEXT_CHARS) {
      contextBlock =
        rawContext.slice(0, MAX_CONTEXT_CHARS) + "... [context truncated]";
    } else {
      contextBlock = rawContext;
    }
  } catch (e) {
    console.error("[PM Chat Participant] Error building auto-context:", e);
  }

  let symbolsBlock = "";
  if (workspaceIndex && prompt.length > 0) {
    const relevantSymbols = findRelevantSymbols(prompt, workspaceIndex, 5);
    symbolsBlock = formatSymbolsBlock(relevantSymbols);
  }

  return `${contextBlock}${symbolsBlock}`;
}

/**
 * #file references con AnchorPart nativo.
 * Legge request.references (file trascinati o referenziati con #nomefile)
 * e li restituisce come array di { uri, content }.
 */
interface ReferencedFile {
  uri: vscode.Uri;
  filename: string;
  lang: string;
  content: string;
}

async function collectReferencedFiles(
  request: vscode.ChatRequest,
): Promise<ReferencedFile[]> {
  if (request.references.length === 0) return [];

  const editor = vscode.window.activeTextEditor;
  const activeBase = editor
    ? editor.document.uri.fsPath.replace(/\.[^.\\/]+$/, "") + "."
    : null;

  const results: ReferencedFile[] = [];
  for (const ref of request.references) {
    const value = ref.value;

    if (typeof value === "string") {
      results.push({
        uri: null as unknown as vscode.Uri,
        filename: "reference",
        lang: "text",
        content: value,
      });
      continue;
    }

    const uri = extractUri(value);
    if (!uri || isAlreadyIncluded(uri, activeBase)) continue;

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let text = Buffer.from(bytes).toString("utf8");
      if (text.length > MAX_REFERENCE_CHARS) {
        text = text.slice(0, MAX_REFERENCE_CHARS) + "\n... [truncated]";
      }
      const filename = getFilename(uri);
      const lang = getExtension(filename) ?? "";
      results.push({ uri, filename, lang, content: text });
    } catch {
      console.debug(
        `[PM Chat Participant] Could not read referenced file: ${uri?.fsPath}`,
      );
    }
  }
  return results;
}

function extractUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value instanceof vscode.Location) return value.uri;
  return undefined;
}

/**
 * Slash commands /fix e /edit — invariati, restano su fetchAction (completion pura).
 */
async function handleActionCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    stream.markdown(
      "⚠️ Apri un file nell'editor e seleziona il codice su cui lavorare.",
    );
    return undefined;
  }

  const document = editor.document;
  const range: vscode.Range = editor.selection.isEmpty
    ? document.lineAt(editor.selection.active.line).range
    : editor.selection;
  const selectedText = document.getText(range);

  if (!selectedText.trim()) {
    stream.markdown(
      "⚠️ Seleziona del codice nell'editor prima di usare questo comando.",
    );
    return undefined;
  }
  if (request.command === "edit" && !request.prompt.trim()) {
    stream.markdown(
      "⚠️ Specifica l'istruzione, es.: `@pm /edit converti in async/await`",
    );
    return undefined;
  }

  const cfg = loadConfig();
  const lang = document.languageId ?? "code";
  const filename = document.fileName.split(/[\\/]/).pop() ?? "unknown";

  const system =
    request.command === "fix"
      ? buildFixSystemPrompt(lang, filename)
      : buildEditSystemPrompt(lang, filename);

  const contextBlock = await buildContextBlock(
    document,
    range,
    cfg.includeRelatedFile,
    request.command === "fix" ? cfg.includeDiagnostics : false,
  );
  const workspaceIndex = loadWorkspaceIndex();
  const symbolsBlock = workspaceIndex
    ? formatSymbolsBlock(findRelevantSymbols(selectedText, workspaceIndex))
    : "";

  const userContent =
    request.command === "fix"
      ? `${contextBlock}${symbolsBlock}\n\nFix this ${lang} code:\n\`\`\`\n${selectedText}\n\`\`\``
      : `${contextBlock}${symbolsBlock}\n\nInstruction: ${request.prompt}\n\nCode:\n\`\`\`\n${selectedText}\n\`\`\``;

  stream.progress("Analizzo il codice selezionato…");

  const result = await fetchAction(
    system,
    userContent,
    cfg.actionServerUrl,
    cfg.serverUrl,
    cfg.actionModelFamily,
    cfg.actionMaxTokens,
    cfg.actionTimeoutMs,
  );

  stream.progress("Elaborazione completata");

  if (!result || result.trim().length === 0) {
    stream.markdown("⚠️ Nessun risultato dal server.");
    return undefined;
  }

  const clean = extractCode(result);
  if (!clean) {
    stream.markdown("⚠️ Impossibile estrarre codice dalla risposta.");
    return undefined;
  }

  stream.markdown(
    `Modifica proposta per \`${filename}\` (righe ${range.start.line + 1}–${range.end.line + 1}):\n\n` +
      `\`\`\`${lang}\n${clean}\n\`\`\`\n`,
  );

  const proposed: ProposedEdit = {
    filePath: document.uri.fsPath,
    content: clean,
    range: {
      startLine: range.start.line,
      startChar: range.start.character,
      endLine: range.end.line,
      endChar: range.end.character,
    },
  };
  stream.button({
    command: "pmAutocomplete.applyEdit",
    arguments: [[proposed]],
    title: "Applica modifiche",
  });

  return undefined;
}

/**
 * Esegue un singolo round di streamChat, ritornando il testo finale e gli
 * eventuali tool_calls richiesti dal modello.
 */
async function runChatRound(
  messages: ChatMessage[],
  endpoint: string,
  model: string,
  stream: vscode.ChatResponseStream,
  renderedLengthRef: { value: number },
  maxTokens: number,
  toolChoice: "auto" | "none" = "auto",
): Promise<{
  finalText: string;
  toolCalls: ToolCall[] | null;
  error: string | null;
  finishReason: string | null;
}> {
  let finalText = "";
  let toolCalls: ToolCall[] | null = null;
  let error: string | null = null;
  let finishReason: string | null = null;

  await streamChat(
    messages,
    endpoint,
    model,
    (fullText) => {
      finalText = fullText;
      const delta = fullText.slice(renderedLengthRef.value);
      renderedLengthRef.value = Math.max(
        renderedLengthRef.value,
        fullText.length,
      );
      if (delta) stream.markdown(delta);
    },
    (reason) => {
      finishReason = reason ?? null;
      console.log(
        `[PM Chat Participant] Stream round completed (finish_reason: ${reason})`,
      );
    },
    (errorMsg) => {
      error = errorMsg;
    },
    TOOL_SPECS,
    (calls) => {
      toolCalls = calls;
    },
    maxTokens,
    toolChoice,
  );

  return { finalText, toolCalls, error, finishReason };
}

/**
 * Handler principale del Chat Participant.
 */
export async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult | undefined> {
  // Slash commands: /fix e /edit passano per fetchAction + preview/apply
  if (request.command === "fix" || request.command === "edit") {
    return handleActionCommand(request, stream);
  }

  // Messaggio informativo al primo turno — puramente descrittivo.
  if (context.history.length === 0) {
    stream.markdown(
      "**Strumenti disponibili:**\n\n" +
        `| Strumento | Descrizione |\n|-----------|-------------|\n` +
        "| 📄 File Attivo | Legge il contenuto del file aperto nell'editor |\n" +
        "| 🔍 Workspace Symbols | Cerca simboli (componenti, servizi, classi) nel workspace |\n" +
        "| 🗂️ Search Files | Trova file per pattern glob |\n" +
        "| 📖 Read File | Legge un file per path, anche se non aperto |\n" +
        "| 🔎 Grep Text | Cerca testo libero nei file del workspace |\n" +
        "| ✏️ Edit File | Applica modifiche ai file (search/replace mirato) |\n" +
        "| 📋 Piano | Per task multi-step, mostra un piano con avanzamento |\n\n",
    );
  }

  // 1. Carica configurazione
  const config = vscode.workspace.getConfiguration("pmChat");
  const endpoint = config.get<string>(
    "endpoint",
    "http://localhost:9000/v1/chat/completions",
  );
  const model = config.get<string>("model", "qwen");
  const systemPrompt = config.get<string>(
    "systemPrompt",
    "You are an expert software developer.",
  );
  const autoContextEnabled = config.get<boolean>("autoContext", true);
  // Budget di output per round. Il vecchio hardcoded 2048 in streamChat troncava
  // le risposte lunghe (analisi + codice) a metà, senza segnalarlo: il fence
  // restava aperto e parseFileEdits non trovava nulla da applicare.
  const maxTokens = config.get<number>("maxTokens", 8192);

  // 2. Carica Workspace Index (se disponibile)
  const workspaceIndex = loadWorkspaceIndex();

  // 3. Costruisci il contesto automatico + #file references
  const autoContext = autoContextEnabled
    ? await buildAutoContext(request.prompt, workspaceIndex)
    : "";
  const referencedFiles = await collectReferencedFiles(request);

  let referencesBlock = "";
  for (const ref of referencedFiles) {
    if (ref.uri && vscode.env.appName.includes("Insiders")) {
      stream.anchor(ref.uri, ref.filename);
    } else if (ref.uri) {
      referencesBlock += `\nReferenced file (${ref.filename}):\n\`\`\`${ref.lang}\n${ref.content}\n\`\`\`\n`;
    } else {
      referencesBlock += `\nReference:\n${ref.content}\n`;
    }
  }

  // 4. Session Summary (solo al primo turno)
  let sessionSummary = "";
  if (context.history.length === 0) {
    const loadedSummary = loadSessionSummary();
    if (loadedSummary) {
      sessionSummary = `[SESSION SUMMARY — earlier conversation]\n${loadedSummary}`;
    }
  }

  // 5. Costruisci i messaggi per l'API.
  // I tool sono comunicati via il campo `tools` (TOOL_SPECS), non descritti a
  // parole. L'unica istruzione testuale che aggiungiamo riguarda il FORMATO
  // di output atteso quando il modello propone una modifica applicabile
  // (EDIT_FORMAT_INSTRUCTION) — non è una descrizione di tool, è un contratto
  // di formattazione che parseFileEdits si aspetta.
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt + EDIT_FORMAT_INSTRUCTION },
  ];

  if (sessionSummary) {
    messages.push({ role: "system", content: sessionSummary });
  }

  const combinedContext = `${autoContext}${referencesBlock}`;
  if (combinedContext.trim().length > 0) {
    messages.push({
      role: "user",
      content: `Here is the relevant context for this request:\n${combinedContext}`,
    });
  }

  // Cronologia della chat precedente (limitata), sanitizzata da eventuali residui
  // di sintassi tool testuale di sessioni pre-migrazione.
  const recentHistory = context.history.slice(-10);
  for (const turn of recentHistory) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: "user", content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter(
          (part): part is vscode.ChatResponseMarkdownPart =>
            part instanceof vscode.ChatResponseMarkdownPart,
        )
        .map((part) => part.value.value)
        .join("");
      if (text) {
        const clean = sanitizeHistoryText(text);
        if (clean) {
          messages.push({ role: "assistant", content: clean });
        }
      }
    }
  }

  messages.push({ role: "user", content: request.prompt });

  // 6. Loop di tool calling: max MAX_TOOL_ROUNDS round, con cap separato sulle
  // letture file (current-file/read-file) per non saturare il contesto se il
  // modello prova a leggere molti file in un solo turno.
  const renderedLengthRef = { value: 0 };
  // Testo di TUTTI i round, non solo l'ultimo: un blocco edit emesso in un round
  // intermedio (seguito da altre tool call) andrebbe perso se parseFileEdits
  // guardasse solo il testo finale.
  let allRoundsText = "";
  let fileReadsUsed = 0;
  // Firma (nome + argomenti) delle tool call read-only già eseguite in questo
  // turno: una chiamata identica ripetuta è il sintomo classico di un modello in
  // loop (rilancia sperando in un output diverso). La intercettiamo e rispondiamo
  // con un avviso senza rieseguire — molto più efficace di un cap sui round.
  const executedCalls = new Set<string>();
  // Stato della todo list, caricato da disco: sopravvive tra i messaggi della
  // stessa conversazione (vedi loadTodoState/saveTodoState).
  let todoItems: TodoItem[] = loadTodoState();
  if (todoItems.length > 0) {
    stream.markdown(formatTodoMarkdown(todoItems));
  }

  stream.progress("Elaborazione richiesta…");

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const {
      finalText: roundText,
      toolCalls,
      error,
      finishReason,
    } = await runChatRound(
      messages,
      endpoint,
      model,
      stream,
      renderedLengthRef,
      maxTokens,
    );

    if (error) {
      stream.markdown(`\n\n⚠️ **Error:** ${error}`);
      return undefined;
    }

    if (roundText) {
      allRoundsText += (allRoundsText ? "\n\n" : "") + roundText;
    }

    // Risposta troncata dal limite di token: dillo chiaramente invece di fingere
    // un completamento normale — l'utente vedrebbe un output interrotto a metà
    // senza spiegazione (e un eventuale fence aperto non è applicabile).
    if (finishReason === "length") {
      stream.markdown(
        `\n\n⚠️ **Risposta troncata:** raggiunto il limite di ${maxTokens} token di output. Aumenta \`pmChat.maxTokens\` nelle impostazioni, oppure chiedi al modello di procedere a passi più piccoli (con edit-file mirati invece di file interi).`,
      );
      break;
    }

    if (!toolCalls || toolCalls.length === 0) {
      break;
    }

    if (round === MAX_TOOL_ROUNDS) {
      // Cap raggiunto con tool call ancora pendenti: invece di troncare il turno
      // a metà lavoro, rispondiamo alle chiamate pendenti con un "non eseguito"
      // e concediamo UN round finale senza tool (tool_choice: none) in cui il
      // modello riassume cosa ha completato e cosa resta da fare.
      messages.push({
        role: "assistant",
        content: roundText || null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id ?? "",
          name: call.function.name ?? "",
          content:
            "⚠️ Limite di tool call per questo messaggio raggiunto: chiamata NON eseguita. Concludi ORA senza altri tool: riassumi cosa hai completato e cosa resta da fare, così l'utente può chiederti di proseguire con un nuovo messaggio.",
        });
      }
      stream.markdown(
        `\n\n⚠️ Raggiunto il limite di ${MAX_TOOL_ROUNDS} round di tool per questo messaggio — chiedo al modello di riassumere lo stato del lavoro.\n\n`,
      );
      renderedLengthRef.value = 0;
      const wrapUp = await runChatRound(
        messages,
        endpoint,
        model,
        stream,
        renderedLengthRef,
        maxTokens,
        "none",
      );
      if (wrapUp.finalText) {
        allRoundsText += (allRoundsText ? "\n\n" : "") + wrapUp.finalText;
      }
      break;
    }

    // Il testo prodotto in questo round va PRESERVATO nella history: con
    // content: null il modello non sa di aver già scritto l'analisi e la
    // ripete identica al round successivo, bruciando token e contesto.
    messages.push({
      role: "assistant",
      content: roundText || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const toolName = call.function.name ?? "";
      const callKey = `${toolName}(${call.function.arguments})`;
      let result: string;

      // Progress per singola chiamata: rende visibile all'utente cosa sta
      // facendo l'agente (e quindi diagnosticabile un eventuale loop).
      stream.progress(`Tool: ${toolName}…`);

      if (toolName === "manage-todo-list") {
        // Intercettato prima di executeTool: richiede stato tra round (todoItems)
        // e un effetto visibile in chat (checklist), non solo un risultato testuale.
        try {
          const args = call.function.arguments.trim()
            ? JSON.parse(call.function.arguments)
            : {};
          const action: "create" | "update" =
            args.action === "update" ? "update" : "create";
          const items = Array.isArray(args.items) ? args.items : [];
          const { next, unknownIds } = applyTodoAction(
            todoItems,
            action,
            items,
          );
          todoItems = next;
          saveTodoState(todoItems);
          stream.markdown(formatTodoMarkdown(todoItems));
          result =
            unknownIds.length > 0
              ? `Piano aggiornato. ID non trovati (ignorati): ${unknownIds.join(", ")}`
              : "Piano aggiornato.";
        } catch (e) {
          result = `⚠️ Errore nell'aggiornamento del piano: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else if (
        READ_ONLY_TOOLS.has(toolName) &&
        executedCalls.has(callKey)
      ) {
        result = `⚠️ Hai già eseguito ${toolName} con questi identici argomenti in questo turno: il risultato sarebbe lo stesso. Non ripetere la chiamata — usa il risultato già ricevuto, cambia argomenti, o rispondi con quello che sai.`;
      } else if (
        FILE_READ_TOOLS.has(toolName) &&
        fileReadsUsed >= MAX_FILE_READS_PER_TURN
      ) {
        result = `⚠️ Limite di ${MAX_FILE_READS_PER_TURN} letture file raggiunto per questo turno. Rispondi con quanto hai già trovato, o chiedi all'utente di restringere la richiesta.`;
      } else {
        result = await executeTool(toolName, call.function.arguments);
        if (FILE_READ_TOOLS.has(toolName)) fileReadsUsed++;
        if (READ_ONLY_TOOLS.has(toolName)) {
          executedCalls.add(callKey);
        } else if (toolName === "edit-file" && result.startsWith("✅")) {
          // Il file è cambiato: le letture precedenti non sono più rappresentative,
          // quindi una ri-lettura con argomenti identici torna a essere legittima.
          executedCalls.clear();
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id ?? "",
        name: toolName,
        content: result,
      });
    }
    // Reset del progresso di rendering: il round successivo produce nuovo testo
    // che deve partire da zero, non accodarsi al delta del round precedente.
    renderedLengthRef.value = 0;
  }

  // 7. Se la risposta contiene blocchi con marker di file (```lang:percorso),
  // proponi l'apply via WorkspaceEdit — funziona sia per file già noti sia per
  // file scoperti nel loop di tool calling qui sopra (search-files/read-file).
  // Si analizza il testo ACCUMULATO di tutti i round, non solo l'ultimo: il
  // blocco edit può essere stato emesso in un round intermedio.
  const proposedEdits = parseFileEdits(allRoundsText);
  if (proposedEdits.length > 0) {
    const fileList = proposedEdits.map((e) => `- \`${e.filePath}\``).join("\n");
    stream.markdown(
      `\n\n---\n📝 **Modifiche proposte** (${proposedEdits.length} file):\n${fileList}\n`,
    );
    stream.button({
      command: "pmAutocomplete.applyEdit",
      arguments: [proposedEdits],
      title: "Applica modifiche",
    });
  }

  return undefined;
}
