import * as vscode from "vscode";
import { abortActiveRequests, fetchAction, fetchCompletion } from "./api";
import { createChatPanel, disposeChatPanel } from "./chatPanel";
import { handleChatRequest } from "./chatParticipant";
import { registerChatTools } from "./chatTools";
import {
  FIM_MIDDLE,
  FIM_PREFIX,
  FIM_SUFFIX,
  loadConfig,
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
} from "./config";
import { buildContextBlock } from "./context";
import { applyProposedEdits, ProposedEdit } from "./edits";
import {
  buildIndex,
  findRelevantSymbols,
  formatSymbolsBlock,
  loadIndex,
  saveIndex,
  WorkspaceIndex,
} from "./indexer";
import { buildEditSystemPrompt, buildFixSystemPrompt } from "./prompts";
import { extractCode } from "./utils";

let statusBarItem: vscode.StatusBarItem;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let lastPrompt = "";
let config = loadConfig();

// ─── Workspace index ──────────────────────────────────────────────────────────

let workspaceIndex: WorkspaceIndex | null = null;

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

async function rebuildIndex(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;
  try {
    workspaceIndex = await buildIndex(root);
    saveIndex(workspaceIndex, root);
    console.log(
      `[PM Indexer] Index built: ${workspaceIndex.symbols.length} symbols`,
    );
  } catch (e) {
    console.error("[PM Indexer] Build failed:", e);
  }
}

function ensureIndex(): void {
  const root = getWorkspaceRoot();
  if (!root) return;
  if (!workspaceIndex) {
    // Try loading from disk first (fast path)
    workspaceIndex = loadIndex(root);
  }
  if (!workspaceIndex) {
    // Build in background — don't block
    rebuildIndex();
  }
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar(text: string) {
  statusBarItem.text = text;
  statusBarItem.show();
}

function syncStatusBar() {
  updateStatusBar(config.enabled ? "$(zap) PM LLM" : "$(zap) PM LLM (off)");
}

// ─── FIM ──────────────────────────────────────────────────────────────────────

function buildFimPrompt(prefix: string, suffix: string): string {
  const p =
    prefix.length > MAX_PREFIX_CHARS ? prefix.slice(-MAX_PREFIX_CHARS) : prefix;
  const s =
    suffix.length > MAX_SUFFIX_CHARS
      ? suffix.slice(0, MAX_SUFFIX_CHARS)
      : suffix;
  return `${FIM_PREFIX}${p}${FIM_SUFFIX}${s}${FIM_MIDDLE}`;
}

// ─── Inline completion ────────────────────────────────────────────────────────

class LlamaInlineProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    cancelToken: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | null> {
    if (!config.enabled) return null;

    await new Promise<void>((resolve) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(resolve, config.debounceMs);
    });

    if (cancelToken.isCancellationRequested) return null;

    const linePrefix = document
      .lineAt(position)
      .text.substring(0, position.character);
    if (linePrefix.trim().length < 2) return null;

    const fullText = document.getText();
    const offset = document.offsetAt(position);
    const prefix = fullText.slice(0, offset);
    const suffix = fullText.slice(offset);
    const prompt = buildFimPrompt(prefix, suffix);

    if (prompt === lastPrompt) return null;
    lastPrompt = prompt;

    updateStatusBar("$(loading~spin) LLM...");
    const completion = await fetchCompletion(
      prompt,
      cancelToken,
      config.serverUrl,
      config.maxTokens,
      config.temperature,
    );
    syncStatusBar();

    if (!completion || completion.length === 0) return null;
    if (suffix.startsWith(completion)) return null;

    return {
      items: [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position),
        ),
      ],
    };
  }
}

// ─── Code actions ─────────────────────────────────────────────────────────────

const FIX_ACTION_KIND = vscode.CodeActionKind.QuickFix;
const EDIT_ACTION_KIND = vscode.CodeActionKind.RefactorRewrite;

class LlamaCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [FIX_ACTION_KIND, EDIT_ACTION_KIND];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const fixAction = new vscode.CodeAction("PM LLM: Fix", FIX_ACTION_KIND);
    fixAction.command = {
      command: "pmAutocomplete.fix",
      title: "PM LLM: Fix",
      arguments: [document, range],
    };

    const editAction = new vscode.CodeAction("PM LLM: Edit…", EDIT_ACTION_KIND);
    editAction.command = {
      command: "pmAutocomplete.edit",
      title: "PM LLM: Edit…",
      arguments: [document, range],
    };

    return [fixAction, editAction];
  }
}

async function applyActionToSelection(
  document: vscode.TextDocument,
  range: vscode.Range,
  systemPrompt: string,
  userContent: string,
): Promise<void> {
  updateStatusBar("$(loading~spin) LLM...");
  const result = await fetchAction(
    systemPrompt,
    userContent,
    config.actionServerUrl,
    config.serverUrl,
    config.actionModelFamily,
    config.actionMaxTokens,
    config.actionTimeoutMs,
  );
  syncStatusBar();

  if (!result || result.trim().length === 0) {
    vscode.window.showWarningMessage("PM LLM: no result from server.");
    return;
  }

  const clean = extractCode(result);
  if (!clean) {
    vscode.window.showWarningMessage(
      "PM LLM: could not extract code from response.",
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await editor.edit((editBuilder) => editBuilder.replace(range, clean));
}

// ─── Fix / Edit ───────────────────────────────────────────────────────────────

async function runFix(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  const selectedText = document.getText(range);
  if (!selectedText.trim()) {
    vscode.window.showWarningMessage("PM LLM: select some code first.");
    return;
  }

  const lang = document.languageId ?? "code";
  const filename = document.fileName.split(/[\\/]/).pop() ?? "unknown";
  const system = buildFixSystemPrompt(lang, filename);

  const contextBlock = await buildContextBlock(
    document,
    range,
    config.includeRelatedFile,
    config.includeDiagnostics,
  );
  const symbolsBlock = workspaceIndex
    ? formatSymbolsBlock(findRelevantSymbols(selectedText, workspaceIndex))
    : "";
  const userContent = `${contextBlock}${symbolsBlock}\n\nFix this ${lang} code:\n\`\`\`\n${selectedText}\n\`\`\``;

  await applyActionToSelection(document, range, system, userContent);
}

async function runEdit(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  const selectedText = document.getText(range);
  if (!selectedText.trim()) {
    vscode.window.showWarningMessage("PM LLM: select some code first.");
    return;
  }

  const lang = document.languageId ?? "code";
  const filename = document.fileName.split(/[\\/]/).pop() ?? "unknown";

  const instruction = await vscode.window.showInputBox({
    prompt: "Describe the edit to apply",
    placeHolder:
      "e.g. add null checks, convert to async/await, add JSDoc comments…",
  });
  if (!instruction) return;

  const system = buildEditSystemPrompt(lang, filename);

  const contextBlock = await buildContextBlock(
    document,
    range,
    config.includeRelatedFile,
    false,
  );
  const symbolsBlock = workspaceIndex
    ? formatSymbolsBlock(findRelevantSymbols(selectedText, workspaceIndex))
    : "";
  const userContent = `${contextBlock}${symbolsBlock}\n\nInstruction: ${instruction}\n\nCode:\n\`\`\`\n${selectedText}\n\`\`\``;

  await applyActionToSelection(document, range, system, userContent);
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "pmAutocomplete.toggle";
  statusBarItem.tooltip = "PM Autocomplete — click to toggle";
  syncStatusBar();

  // Load or build workspace index
  ensureIndex();

  // ─── Chat Participant Registration (Fase 1) ────────────────────────────────

  const participant = vscode.chat.createChatParticipant(
    "pmAutocomplete.chat",
    handleChatRequest,
  );

  // Register tools so VS Code can inject context automatically (Copilot Chat UX)
  registerChatTools(context);

  // Re-index on file save (debounced — only TS/CS files)
  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    const ext = doc.fileName.split(".").pop()?.toLowerCase();
    if (ext === "ts" || ext === "cs") {
      rebuildIndex();
    }
  });

  // Manual re-index command
  const reindexCmd = vscode.commands.registerCommand(
    "pmAutocomplete.reindex",
    async () => {
      updateStatusBar("$(loading~spin) Indexing…");
      await rebuildIndex();
      syncStatusBar();
      vscode.window.showInformationMessage(
        `PM LLM: index built — ${workspaceIndex?.symbols.length ?? 0} symbols`,
      );
    },
  );

  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("pmAutocomplete") ||
      e.affectsConfiguration("pmChat")
    ) {
      config = loadConfig();
      syncStatusBar();
    }
  });

  const toggleCmd = vscode.commands.registerCommand(
    "pmAutocomplete.toggle",
    () => {
      const cfg = vscode.workspace.getConfiguration("pmAutocomplete");
      const current = cfg.get<boolean>("enabled", true);
      cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `PM Autocomplete: ${!current ? "ON" : "OFF"}`,
      );
    },
  );

  // Fase 4 — apply delle modifiche proposte in chat, solo al click sul bottone
  const applyEditCmd = vscode.commands.registerCommand(
    "pmAutocomplete.applyEdit",
    async (edits: ProposedEdit[]) => {
      if (!Array.isArray(edits) || edits.length === 0) return;
      const ok = await applyProposedEdits(edits);
      if (ok) {
        vscode.window.showInformationMessage(
          `PM LLM: modifiche applicate (${edits.length} file).`,
        );
      } else {
        vscode.window.showWarningMessage(
          "PM LLM: apply non riuscito o annullato.",
        );
      }
    },
  );

  const openChatCmd = vscode.commands.registerCommand("pmChat.open", () => {
    // Apre il pannello chat HTML personalizzato
    createChatPanel(context, loadConfig);
  });

  const fixCmd = vscode.commands.registerCommand(
    "pmAutocomplete.fix",
    (doc?: vscode.TextDocument, range?: vscode.Range) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const d = doc ?? editor.document;
      const r =
        range ??
        (editor.selection.isEmpty
          ? editor.document.lineAt(editor.selection.active.line).range
          : editor.selection);
      runFix(d, r);
    },
  );

  const editCmd = vscode.commands.registerCommand(
    "pmAutocomplete.edit",
    (doc?: vscode.TextDocument, range?: vscode.Range) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const d = doc ?? editor.document;
      const r =
        range ??
        (editor.selection.isEmpty
          ? editor.document.lineAt(editor.selection.active.line).range
          : editor.selection);
      runEdit(d, r);
    },
  );

  const inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    new LlamaInlineProvider(),
  );
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    { pattern: "**" },
    new LlamaCodeActionProvider(),
    {
      providedCodeActionKinds: LlamaCodeActionProvider.providedCodeActionKinds,
    },
  );

  context.subscriptions.push(
    participant,
    inlineProvider,
    codeActionProvider,
    toggleCmd,
    openChatCmd,
    applyEditCmd,
    fixCmd,
    editCmd,
    reindexCmd,
    onSave,
    statusBarItem,
    configWatcher,
  );

  console.log("[PM Autocomplete] Active — server:", config.serverUrl);
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  abortActiveRequests();
  disposeChatPanel();
}
