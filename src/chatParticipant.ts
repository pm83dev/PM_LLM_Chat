import * as vscode from "vscode";
import { fetchAction, streamChat } from "./api";
import { loadConfig } from "./config";
import { buildContextBlock } from "./context";
import { parseFileEdits, ProposedEdit } from "./edits";
import {
  findRelevantSymbols,
  formatSymbolsBlock,
  loadIndex,
  WorkspaceIndex,
} from "./indexer";
import {
  buildEditSystemPrompt,
  buildFixSystemPrompt,
  EDIT_FORMAT_INSTRUCTION,
} from "./prompts";
import { extractCode } from "./utils";
/* eslint-disable @typescript-eslint/no-restricted-imports */
import * as fs from "fs";
import * as path from "path";
/* eslint-enable @typescript-eslint/no-restricted-imports */

// Costanti di configurazione locali per evitare dipendenze circolari o accoppiamento stretto
const SUMMARY_FILENAME = ".pm_context_summary.json";
const MAX_CONTEXT_CHARS = 3000; // Soglia simile a quella usata in chatPanel.ts per inject file
const MAX_REFERENCE_CHARS = 3000; // Cap per ogni file referenziato con #file

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
  // activeBase è qualcosa come "c:/path/to/file." — controlla se l'URI parte da quella base
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
// eslint-disable-next-line @typescript-eslint/no-array-index-later
function getExtension(filename: string): string | undefined {
  const parts = filename.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : undefined;
}

/* eslint-disable-next-line @typescript-eslint/no-restricted-imports */

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

  // 1. Contesto del file attivo e gemello (riusa la logica di context.ts ma adattata per chat)
  let contextBlock = "";
  try {
    // buildContextBlock richiede un range, usiamo il documento intero o una selezione se presente
    const selectionRange = editor.selection.isEmpty
      ? new vscode.Range(0, 0, document.lineCount, 0)
      : editor.selection;

    const rawContext = await buildContextBlock(
      document,
      selectionRange,
      true,
      false,
    ); // includeRelatedFile=true, diagnostics=false per chat
    if (rawContext && rawContext.length > MAX_CONTEXT_CHARS) {
      contextBlock =
        rawContext.slice(0, MAX_CONTEXT_CHARS) + "... [context truncated]";
    } else {
      contextBlock = rawContext;
    }
  } catch (e) {
    console.error("[PM Chat Participant] Error building auto-context:", e);
  }

  // 2. Simboli rilevanti dall'indice workspace (Code RAG)
  let symbolsBlock = "";
  if (workspaceIndex && prompt.length > 0) {
    const relevantSymbols = findRelevantSymbols(prompt, workspaceIndex, 5); // Max 5 simboli per non gonfiare troppo
    symbolsBlock = formatSymbolsBlock(relevantSymbols);
  }

  return `${contextBlock}${symbolsBlock}`;
}

/**
 * Fase 3 — #file references native.
 * Legge request.references (file trascinati o referenziati con #nomefile)
 * e li aggiunge al blocco di contesto. Deduplica il file attivo e il suo
 * gemello, già inclusi da buildContextBlock().
 */
async function collectReferencedFiles(
  request: vscode.ChatRequest,
): Promise<string> {
  if (request.references.length === 0) return "";

  const editor = vscode.window.activeTextEditor;
  const activeBase = editor
    ? editor.document.uri.fsPath.replace(/\.[^.\\/]+$/, "") + "."
    : null;

  let out = "";
  for (const ref of request.references) {
    const value = ref.value;

    if (typeof value === "string") {
      out += `\nReference:\n${value}\n`;
      continue;
    }

    const uri = extractUri(value);
    if (!uri || isAlreadyIncluded(uri, activeBase)) continue;

    try {
      const content = await readReferencedFile(uri);
      if (content) out += content;
    } catch {
      // file non leggibile — skip
    }
  }
  return out;
}

/**
 * Estrae vscode.Uri da un reference value.
 */
function extractUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value instanceof vscode.Location) return value.uri;
  return undefined;
}

/**
 * Legge il contenuto di un file referenziato e lo formatta.
 */
async function readReferencedFile(uri: vscode.Uri): Promise<string | null> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  let text = Buffer.from(bytes).toString("utf8");
  if (text.length > MAX_REFERENCE_CHARS) {
    text = text.slice(0, MAX_REFERENCE_CHARS) + "\n... [truncated]";
  }
  const filename = getFilename(uri);
  const lang = getExtension(filename) ?? "";
  return `\nReferenced file (${filename}):\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
}

/**
 * Fase 5 — Slash commands /fix e /edit.
 * Riusa fetchAction() con la selezione attiva (stessa logica dei comandi
 * editor Ctrl+. / Ctrl+Shift+.) ma dentro il flusso chat: il risultato viene
 * mostrato come preview con bottone "Applica modifiche" (Fase 4) invece di
 * sostituire direttamente il testo.
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

  stream.progress("Interrogo il modello…");

  const result = await fetchAction(
    system,
    userContent,
    cfg.actionServerUrl,
    cfg.serverUrl,
    cfg.actionModelFamily,
    cfg.actionMaxTokens,
    cfg.actionTimeoutMs,
  );

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

  // 1. Carica configurazione
  const config = vscode.workspace.getConfiguration("pmChat");
  const endpoint = config.get<string>(
    "endpoint",
    "http://localhost:9000/v1/chat/completions",
  );
  const model = config.get<string>("model", "gemma4");
  const systemPrompt = config.get<string>(
    "systemPrompt",
    "You are an expert software developer.",
  );
  const autoContextEnabled = config.get<boolean>("autoContext", true);

  // 2. Carica Workspace Index (se disponibile)
  const workspaceIndex = loadWorkspaceIndex();

  // 3. Costruisci il contesto automatico (Fase 2) + #file references (Fase 3)
  const autoContext = autoContextEnabled
    ? await buildAutoContext(request.prompt, workspaceIndex)
    : "";
  const referencesBlock = await collectReferencedFiles(request);

  // 4. Gestisci Session Summary (solo al primo turno della conversazione)
  let sessionSummary = "";
  if (context.history.length === 0) {
    const loadedSummary = loadSessionSummary();
    if (loadedSummary) {
      sessionSummary = `[SESSION SUMMARY — earlier conversation]\n${loadedSummary}`;
    }
  }

  // 5. Costruisci i messaggi per l'API
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [];

  messages.push({
    role: "system",
    content: `${systemPrompt}\n\n${EDIT_FORMAT_INSTRUCTION}`,
  });

  if (sessionSummary) {
    messages.push({ role: "system", content: sessionSummary });
  }

  // Inietta contesto automatico + file referenziati prima del prompt utente
  const combinedContext = `${autoContext}${referencesBlock}`;
  if (combinedContext.trim().length > 0) {
    messages.push({
      role: "user",
      content: `Here is the relevant context for this request:\n${combinedContext}`,
    });
  }

  // Aggiungi la cronologia della chat precedente (limitata per risparmiare token)
  const recentHistory = context.history.slice(-10); // Ultimi 10 turni
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
        messages.push({ role: "assistant", content: text });
      }
    }
  }

  messages.push({ role: "user", content: request.prompt });

  // 6. Esegui lo streaming verso l'output del Chat Participant
  // Nota: streamChat passa a onChunk il testo cumulativo (già ripulito dai think-tag),
  // mentre stream.markdown() appende — quindi emettiamo solo il delta.
  let renderedLength = 0;
  let finalText = "";

  await streamChat(
    messages,
    endpoint,
    model,
    (fullText) => {
      finalText = fullText;
      const delta = fullText.slice(renderedLength);
      renderedLength = Math.max(renderedLength, fullText.length);
      if (delta) stream.markdown(delta);
    },
    () => {
      console.log("[PM Chat Participant] Stream completed");
    },
    (errorMsg) => {
      stream.markdown(`\n\n⚠️ **Error:** ${errorMsg}`);
    },
  );

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
