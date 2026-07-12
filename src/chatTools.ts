import * as vscode from "vscode";

/**
 * Strumento "current-file" — restituisce il contenuto del file attualmente
 * aperto nell'editor attivo. Utile quando l'utente non ha trascinato alcun file
 * ma vuole comunque che il modello veda il contesto corrente.
 */
class CurrentFileTool implements vscode.LanguageModelTool<CurrentFileInput> {
  name = "current-file";
  description =
    "Reads the content of the currently active editor file. Use this when the user's request relates to the code they are looking at.";
  inputSchema = {
    type: "object",
    properties: {},
  } as object;

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<CurrentFileInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("⚠️ Nessun file aperto nell'editor."),
      ]);
    }

    const doc = editor.document;
    const text = doc.getText();
    const maxChars = 8000;
    let truncated = text;
    if (text.length > maxChars) {
      truncated = text.slice(0, maxChars) + "\n... [truncated]";
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `File attivo: ${doc.fileName}\nLinguaggio: ${doc.languageId}\n\n${truncated}`,
      ),
    ]);
  }
}

/**
 * Strumento "workspace-symbols" — cerca simboli rilevanti nell'indice workspace.
 */
class WorkspaceSymbolsTool implements vscode.LanguageModelTool<WorkspaceSymbolsInput> {
  name = "workspace-symbols";
  description =
    "Searches the workspace index for relevant symbols (components, services, interfaces, classes, methods). Use this to find definitions across the codebase.";
  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search term to find in symbol names and descriptions.",
      },
    },
  } as object;

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<WorkspaceSymbolsInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
    const query = options.input?.query ?? "";
    if (!query.trim()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⚠️ Fornisci un termine di ricerca per la query.",
        ),
      ]);
    }

    // L'indice workspace è condiviso con extension.ts — qui facciamo un fallback
    // che legge l'indice da disco (stessa logica di chatParticipant.loadWorkspaceIndex)
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("⚠️ Nessun workspace aperto."),
      ]);
    }

    // Usa le funzioni importate da indexer.ts
    const idx = loadIndex(folders[0].uri.fsPath);
    if (!idx) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "⚠️ Indice workspace non disponibile. Esegui /pmAutocomplete.reindex.",
        ),
      ]);
    }

    const relevant = findRelevantSymbols(query, idx, 10);
    const formatted = formatSymbolsBlock(relevant);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(formatted || "Nessun simbolo trovato."),
    ]);
  }
}

/** Input per current-file tool (nessun parametro richiesto). */
interface CurrentFileInput {}

/** Input per workspace-symbols tool. */
interface WorkspaceSymbolsInput {
  query: string;
}

/**
 * Registra tutti gli strumenti disponibili per il Chat Participant.
 */
export function registerChatTools(context: vscode.ExtensionContext): void {
  const currentFileTool = new CurrentFileTool();
  const workspaceSymbolsTool = new WorkspaceSymbolsTool();

  context.subscriptions.push(
    vscode.lm.registerTool(currentFileTool.name, currentFileTool),
    vscode.lm.registerTool(workspaceSymbolsTool.name, workspaceSymbolsTool),
  );
}
