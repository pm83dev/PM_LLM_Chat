import * as path from "path";
import * as vscode from "vscode";
import { ToolSpec } from "./api";
import { formatSymbolsBlock, loadIndex, searchSymbolsByName } from "./indexer";

// ──────────────────────────────────────────────
// Costanti condivise con indexer.ts (stessi criteri di esclusione, tenute qui
// duplicate per evitare accoppiamento — se cambi EXCLUDE_GLOBS in indexer.ts,
// aggiorna anche qui).
// ──────────────────────────────────────────────
const EXCLUDE_GLOBS =
  "**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/bin/**,**/obj/**";
const MAX_FILE_SIZE = 200 * 1024; // 200KB, come in indexer.ts
const MAX_READ_CHARS = 8000; // stesso cap di getCurrentFileContent
const MAX_SEARCH_RESULTS = 40;
const MAX_GREP_FILES_SCANNED = 500; // limite duro per non bloccare su workspace enormi
const MAX_GREP_MATCHES = 30;

// ──────────────────────────────────────────────
// Utility functions esistenti
// ──────────────────────────────────────────────

/** Legge il contenuto del file attivo nell'editor. */
export function getCurrentFileContent(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return "⚠️ Nessun file aperto nell'editor.";
  }

  const doc = editor.document;
  const text = doc.getText();
  let truncated = text;
  if (text.length > MAX_READ_CHARS) {
    truncated = text.slice(0, MAX_READ_CHARS) + "\n... [truncated]";
  }

  return `File attivo: ${doc.fileName}\nLinguaggio: ${doc.languageId}\n\n${truncated}`;
}

/** Cerca simboli nell'indice workspace e restituisce il blocco formattato. */
export function searchWorkspaceSymbols(query: string): string {
  if (!query.trim()) {
    return "⚠️ Fornisci un termine di ricerca per la query.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  const idx = loadIndex(folders[0].uri.fsPath);
  if (!idx) {
    return "⚠️ Indice workspace non disponibile. Esegui /pmAutocomplete.reindex.";
  }

  const relevant = searchSymbolsByName(query, idx, 10);
  const formatted = formatSymbolsBlock(relevant);

  return formatted || "Nessun simbolo trovato.";
}

/** Verifica se i tool VS Code nativi sono disponibili (VS Code 1.97+, Copilot Chat). */
export function isToolsApiAvailable(): boolean {
  try {
    return typeof (vscode.lm as any).registerTool === "function";
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// Sicurezza path — stessa policy di edits.ts (isSafeRelativePath):
// rifiuta path assoluti o con traversal, il modello deve restare nel workspace.
// Duplicata qui perché edits.ts non la esporta; se la esponi, sostituisci con import.
// ──────────────────────────────────────────────
function isSafeRelativePath(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p).replace(/\\/g, "/");
  return !normalized.startsWith("..") && !normalized.includes("/../");
}

// ──────────────────────────────────────────────
// Nuovi tool — esplorazione file arbitrari (stile Copilot: search → read → grep)
// ──────────────────────────────────────────────

/** Cerca file per glob pattern, ritorna solo i path (non il contenuto). */
async function searchFiles(glob: string): Promise<string> {
  if (!glob.trim()) {
    return "⚠️ Fornisci un pattern glob, es. **/*Controller.cs";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  try {
    const uris = await vscode.workspace.findFiles(
      glob,
      `{${EXCLUDE_GLOBS}}`,
      MAX_SEARCH_RESULTS,
    );
    if (uris.length === 0) {
      return `Nessun file trovato per il pattern "${glob}".`;
    }
    const root = folders[0].uri.fsPath;
    const relPaths = uris.map((u) =>
      path.relative(root, u.fsPath).replace(/\\/g, "/"),
    );
    const suffix =
      uris.length === MAX_SEARCH_RESULTS
        ? `\n... (limite di ${MAX_SEARCH_RESULTS} risultati raggiunto, affina il pattern)`
        : "";
    return `File trovati (${relPaths.length}):\n${relPaths.map((p) => `- ${p}`).join("\n")}${suffix}`;
  } catch (e) {
    return `⚠️ Errore nella ricerca file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Legge un file arbitrario del workspace dato il path relativo (non richiede che sia aperto nell'editor). */
async function readFile(relPath: string): Promise<string> {
  if (!relPath.trim()) {
    return "⚠️ Fornisci il percorso relativo del file da leggere.";
  }
  if (!isSafeRelativePath(relPath)) {
    return "⚠️ Percorso non valido: usa un path relativo al workspace, senza .. o path assoluti.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  try {
    const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    let text = Buffer.from(bytes).toString("utf8");
    if (text.length > MAX_READ_CHARS) {
      text = text.slice(0, MAX_READ_CHARS) + "\n... [truncated]";
    }
    return `File: ${relPath}\n\n${text}`;
  } catch {
    return `⚠️ File non trovato o non leggibile: ${relPath}`;
  }
}

/** Ricerca testuale (grep) su file del workspace, con numero di riga per ogni match. */
async function grepText(query: string, glob?: string): Promise<string> {
  if (!query.trim()) {
    return "⚠️ Fornisci un termine da cercare.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  const root = folders[0].uri.fsPath;
  const includeGlob = glob?.trim() || "**/*.{ts,tsx,cs,html,json,md}";

  try {
    const uris = await vscode.workspace.findFiles(
      includeGlob,
      `{${EXCLUDE_GLOBS}}`,
      MAX_GREP_FILES_SCANNED,
    );

    const needle = query.toLowerCase();
    const matches: string[] = [];

    for (const uri of uris) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_SIZE) continue;

        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const lines = text.split("\n");
        const relPath = path.relative(root, uri.fsPath).replace(/\\/g, "/");

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push(
              `${relPath}:${i + 1}: ${lines[i].trim().slice(0, 150)}`,
            );
            if (matches.length >= MAX_GREP_MATCHES) break;
          }
        }
      } catch {
        continue; // file non leggibile — skip
      }
    }

    if (matches.length === 0) {
      return `Nessun risultato per "${query}"${glob ? ` (pattern: ${glob})` : ""}.`;
    }
    const suffix =
      matches.length >= MAX_GREP_MATCHES
        ? `\n... (limite di ${MAX_GREP_MATCHES} match raggiunto, affina la query)`
        : "";
    return `Risultati per "${query}" (${matches.length}):\n${matches.join("\n")}${suffix}`;
  } catch (e) {
    return `⚠️ Errore nella ricerca testuale: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ──────────────────────────────────────────────
// Tool calling nativo per il chat participant @pm (via streamChat + llama-server)
// ──────────────────────────────────────────────

/** Schema JSON dei tool, inoltrato a llama-server nel campo `tools` della request. */
export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "current-file",
      description: "Reads the content of the currently active editor file.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace-symbols",
      description:
        "Searches the workspace index for symbols (components, services, classes, methods) by name, case-insensitive substring match.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term to match against symbol names.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search-files",
      description:
        "Finds files in the workspace by glob pattern (e.g. '**/*Controller.cs', '**/QuoteDto.cs'). Returns file paths only, not content. Use this before read-file when you don't know the exact path.",
      parameters: {
        type: "object",
        properties: {
          glob: {
            type: "string",
            description: "Glob pattern relative to workspace root.",
          },
        },
        required: ["glob"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read-file",
      description:
        "Reads the full content of a specific file in the workspace by its relative path, even if it's not open in the editor. Use search-files or workspace-symbols first if you don't know the exact path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to the workspace root.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep-text",
      description:
        "Searches for a text string across files in the workspace and returns matching lines with file path and line number. Use this to find code that isn't a named symbol (e.g. a string literal, a route, a config value).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for (case-insensitive).",
          },
          glob: {
            type: "string",
            description:
              "Optional glob to restrict the search (default: common source file extensions).",
          },
        },
        required: ["query"],
      },
    },
  },
];

/** Nomi dei tool che leggono contenuto file — usati dal caller per applicare un cap separato su quante letture concedere per conversazione. */
export const FILE_READ_TOOLS = new Set(["current-file", "read-file"]);

/**
 * Esegue un tool per nome, dato l'argomento JSON grezzo ricevuto da un tool_call.
 * Async: read-file/search-files/grep-text fanno I/O su disco/workspace.
 * Non lancia mai — ritorna sempre una stringa (errore incluso) da rimandare al
 * modello come risultato del tool.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
): Promise<string> {
  try {
    switch (name) {
      case "current-file":
        return getCurrentFileContent();

      case "workspace-symbols": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return searchWorkspaceSymbols(
          typeof args.query === "string" ? args.query : "",
        );
      }

      case "search-files": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return await searchFiles(
          typeof args.glob === "string" ? args.glob : "",
        );
      }

      case "read-file": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return await readFile(typeof args.path === "string" ? args.path : "");
      }

      case "grep-text": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return await grepText(
          typeof args.query === "string" ? args.query : "",
          typeof args.glob === "string" ? args.glob : undefined,
        );
      }

      default:
        return `⚠️ Tool sconosciuto: ${name}`;
    }
  } catch (e) {
    console.error(`[PM Chat] Errore eseguendo tool ${name}:`, e);
    return `⚠️ Errore nell'esecuzione del tool ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ──────────────────────────────────────────────
// Registrazione tool nativi VS Code (vscode.lm.registerTool) — meccanismo separato,
// usato quando l'utente interagisce con questi tool da Copilot Chat / agent mode,
// non dal nostro chat participant @pm (che usa TOOL_SPECS + executeTool sopra).
// Richiede VS Code 1.97+. NB: qui registriamo solo i due tool storici; se vuoi
// esporre anche search-files/read-file/grep-text a Copilot nativo, aggiungi
// classi analoghe a CurrentFileTool/WorkspaceSymbolsTool sotto.
// ──────────────────────────────────────────────

export function registerChatTools(context: vscode.ExtensionContext): void {
  if (!isToolsApiAvailable()) {
    console.log(
      "[PM Chat] Tools API nativa non disponibile — versione VS Code troppo vecchia per vscode.lm.registerTool",
    );
    return;
  }

  const currentFileTool = new CurrentFileTool();
  const workspaceSymbolsTool = new WorkspaceSymbolsTool();

  context.subscriptions.push(
    vscode.lm.registerTool(currentFileTool.name, currentFileTool),
    vscode.lm.registerTool(workspaceSymbolsTool.name, workspaceSymbolsTool),
  );
}

class CurrentFileTool implements vscode.LanguageModelTool<CurrentFileInput> {
  name = "current-file";
  description = "Reads the content of the currently active editor file.";

  inputSchema = { type: "object", properties: {} } as object;

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<CurrentFileInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
    const content = getCurrentFileContent();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(content),
    ]);
  }
}

class WorkspaceSymbolsTool implements vscode.LanguageModelTool<WorkspaceSymbolsInput> {
  name = "workspace-symbols";
  description = "Searches the workspace index for relevant symbols.";

  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search term to find in symbol names.",
      },
    },
  } as object;

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<WorkspaceSymbolsInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
    const query = options.input?.query ?? "";
    const result = searchWorkspaceSymbols(query);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result),
    ]);
  }
}

interface CurrentFileInput {}

interface WorkspaceSymbolsInput {
  query: string;
}
