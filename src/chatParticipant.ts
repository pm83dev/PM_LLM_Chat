import * as vscode from "vscode";
import { ChatMessage, fetchAction, streamChat, ToolCall } from "./api";
import { executeTool, TOOL_SPECS } from "./chatTools";
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
const MAX_CONTEXT_CHARS = 3000; // Soglia simile a quella usata in chatPanel.ts per inject file
const MAX_REFERENCE_CHARS = 3000; // Cap per ogni file referenziato con #file
const MAX_TOOL_ROUNDS = 3; // Limite di round tool-call consecutivi, evita loop infiniti

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
 * eventuali tool_calls richiesti dal modello. Isolato per essere richiamabile
 * più volte nel loop di tool calling senza duplicare la gestione del progress/onChunk.
 */
async function runChatRound(
  messages: ChatMessage[],
  endpoint: string,
  model: string,
  stream: vscode.ChatResponseStream,
  renderedLengthRef: { value: number },
): Promise<{
  finalText: string;
  toolCalls: ToolCall[] | null;
  error: string | null;
}> {
  let finalText = "";
  let toolCalls: ToolCall[] | null = null;
  let error: string | null = null;

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
    () => {
      console.log("[PM Chat Participant] Stream round completed");
    },
    (errorMsg) => {
      error = errorMsg;
    },
    TOOL_SPECS,
    (calls) => {
      toolCalls = calls;
    },
  );

  return { finalText, toolCalls, error };
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

  // Messaggio informativo al primo turno — puramente descrittivo, non condiziona
  // più il comportamento del modello (i tool sono sempre passati via TOOL_SPECS).
  if (context.history.length === 0) {
    stream.markdown(
      "**Strumenti disponibili:**\n\n" +
        `| Strumento | Descrizione |\n|-----------|-------------|\n` +
        "| 📄 File Attivo | Legge il contenuto del file aperto nell'editor |\n" +
        "| 🔍 Workspace Symbols | Cerca simboli (componenti, servizi, classi) nel workspace |\n\n",
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
  // Niente più TOOLS_BLOCK testuale né istruzioni XML: i tool sono comunicati
  // al modello via il campo `tools` della request (vedi TOOL_SPECS in chatTools.ts),
  // non descritti a parole nel system prompt.
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

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

  // 6. Loop di tool calling: al massimo MAX_TOOL_ROUNDS round prima di forzare
  // una risposta testuale, per evitare loop infiniti se il modello continua
  // a richiedere tool.
  const renderedLengthRef = { value: 0 };
  let finalText = "";

  stream.progress("Elaborazione richiesta…");

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const {
      finalText: roundText,
      toolCalls,
      error,
    } = await runChatRound(
      messages,
      endpoint,
      model,
      stream,
      renderedLengthRef,
    );

    if (error) {
      stream.markdown(`\n\n⚠️ **Error:** ${error}`);
      return undefined;
    }

    finalText = roundText;

    if (!toolCalls || toolCalls.length === 0) {
      // Nessun tool richiesto: questa è la risposta finale.
      break;
    }

    if (round === MAX_TOOL_ROUNDS) {
      stream.markdown(
        "\n\n⚠️ Troppi tool call consecutivi, interrompo per evitare un loop.",
      );
      break;
    }

    // Il modello ha richiesto uno o più tool: esegui ed inietta i risultati,
    // poi ripeti il round così il modello può formulare la risposta finale.
    stream.progress("Esecuzione tool…");

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const toolName = call.function.name ?? "";
      const result = executeTool(toolName, call.function.arguments);
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

  // 7. Fase 4 — se la risposta contiene blocchi con marker di file
  // (```lang:percorso), proponi l'apply via WorkspaceEdit
  const proposedEdits = parseFileEdits(finalText);
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
