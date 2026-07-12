import * as vscode from "vscode";
import { ToolSpec } from "./api";
import { formatSymbolsBlock, loadIndex, searchSymbolsByName } from "./indexer";

// ──────────────────────────────────────────────
// Utility functions (non-class) — usate sia dal dispatcher del chat participant
// sia dalle classi vscode.lm.registerTool sotto.
// ──────────────────────────────────────────────

/** Legge il contenuto del file attivo nell'editor. */
export function getCurrentFileContent(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return "⚠️ Nessun file aperto nell'editor.";
  }

  const doc = editor.document;
  const text = doc.getText();
  const maxChars = 8000;
  let truncated = text;
  if (text.length > maxChars) {
    truncated = text.slice(0, maxChars) + "\n... [truncated]";
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
        "Searches the workspace index for symbols (components, services, classes, methods) by name.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search term to match against symbol names (case-insensitive substring).",
          },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * Esegue un tool per nome, dato l'argomento JSON grezzo ricevuto da un tool_call.
 * Usato dal loop di tool calling in chatRequestHandler.ts — non lancia mai,
 * ritorna sempre una stringa (messaggio di errore incluso) da rimandare al modello
 * come risultato del tool.
 */
export function executeTool(name: string, rawArguments: string): string {
  try {
    switch (name) {
      case "current-file":
        return getCurrentFileContent();

      case "workspace-symbols": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        const query = typeof args.query === "string" ? args.query : "";
        return searchWorkspaceSymbols(query);
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
// Richiede VS Code 1.97+.
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
