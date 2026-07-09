"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
const chatPanel_1 = require("./chatPanel");
const chatParticipant_1 = require("./chatParticipant");
const config_1 = require("./config");
const context_1 = require("./context");
const edits_1 = require("./edits");
const indexer_1 = require("./indexer");
const prompts_1 = require("./prompts");
const utils_1 = require("./utils");
let statusBarItem;
let debounceTimer;
let lastPrompt = "";
let config = (0, config_1.loadConfig)();
// ─── Workspace index ──────────────────────────────────────────────────────────
let workspaceIndex = null;
function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}
async function rebuildIndex() {
    const root = getWorkspaceRoot();
    if (!root)
        return;
    try {
        workspaceIndex = await (0, indexer_1.buildIndex)(root);
        (0, indexer_1.saveIndex)(workspaceIndex, root);
        console.log(`[PM Indexer] Index built: ${workspaceIndex.symbols.length} symbols`);
    }
    catch (e) {
        console.error("[PM Indexer] Build failed:", e);
    }
}
function ensureIndex() {
    const root = getWorkspaceRoot();
    if (!root)
        return;
    if (!workspaceIndex) {
        // Try loading from disk first (fast path)
        workspaceIndex = (0, indexer_1.loadIndex)(root);
    }
    if (!workspaceIndex) {
        // Build in background — don't block
        rebuildIndex();
    }
}
// ─── Status bar ───────────────────────────────────────────────────────────────
function updateStatusBar(text) {
    statusBarItem.text = text;
    statusBarItem.show();
}
function syncStatusBar() {
    updateStatusBar(config.enabled ? "$(zap) PM LLM" : "$(zap) PM LLM (off)");
}
// ─── FIM ──────────────────────────────────────────────────────────────────────
function buildFimPrompt(prefix, suffix) {
    const p = prefix.length > config_1.MAX_PREFIX_CHARS ? prefix.slice(-config_1.MAX_PREFIX_CHARS) : prefix;
    const s = suffix.length > config_1.MAX_SUFFIX_CHARS
        ? suffix.slice(0, config_1.MAX_SUFFIX_CHARS)
        : suffix;
    return `${config_1.FIM_PREFIX}${p}${config_1.FIM_SUFFIX}${s}${config_1.FIM_MIDDLE}`;
}
// ─── Inline completion ────────────────────────────────────────────────────────
class LlamaInlineProvider {
    async provideInlineCompletionItems(document, position, _context, cancelToken) {
        if (!config.enabled)
            return null;
        await new Promise((resolve) => {
            if (debounceTimer)
                clearTimeout(debounceTimer);
            debounceTimer = setTimeout(resolve, config.debounceMs);
        });
        if (cancelToken.isCancellationRequested)
            return null;
        const linePrefix = document
            .lineAt(position)
            .text.substring(0, position.character);
        if (linePrefix.trim().length < 2)
            return null;
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const prefix = fullText.slice(0, offset);
        const suffix = fullText.slice(offset);
        const prompt = buildFimPrompt(prefix, suffix);
        if (prompt === lastPrompt)
            return null;
        lastPrompt = prompt;
        updateStatusBar("$(loading~spin) LLM...");
        const completion = await (0, api_1.fetchCompletion)(prompt, cancelToken, config.serverUrl, config.maxTokens, config.temperature);
        syncStatusBar();
        if (!completion || completion.length === 0)
            return null;
        if (suffix.startsWith(completion))
            return null;
        return {
            items: [
                new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)),
            ],
        };
    }
}
// ─── Code actions ─────────────────────────────────────────────────────────────
const FIX_ACTION_KIND = vscode.CodeActionKind.QuickFix;
const EDIT_ACTION_KIND = vscode.CodeActionKind.RefactorRewrite;
class LlamaCodeActionProvider {
    provideCodeActions(document, range) {
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
LlamaCodeActionProvider.providedCodeActionKinds = [FIX_ACTION_KIND, EDIT_ACTION_KIND];
async function applyActionToSelection(document, range, systemPrompt, userContent) {
    updateStatusBar("$(loading~spin) LLM...");
    const result = await (0, api_1.fetchAction)(systemPrompt, userContent, config.actionServerUrl, config.serverUrl, config.actionModelFamily, config.actionMaxTokens, config.actionTimeoutMs);
    syncStatusBar();
    if (!result || result.trim().length === 0) {
        vscode.window.showWarningMessage("PM LLM: no result from server.");
        return;
    }
    const clean = (0, utils_1.extractCode)(result);
    if (!clean) {
        vscode.window.showWarningMessage("PM LLM: could not extract code from response.");
        return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    await editor.edit((editBuilder) => editBuilder.replace(range, clean));
}
// ─── Fix / Edit ───────────────────────────────────────────────────────────────
async function runFix(document, range) {
    const selectedText = document.getText(range);
    if (!selectedText.trim()) {
        vscode.window.showWarningMessage("PM LLM: select some code first.");
        return;
    }
    const lang = document.languageId ?? "code";
    const filename = document.fileName.split(/[\\/]/).pop() ?? "unknown";
    const system = (0, prompts_1.buildFixSystemPrompt)(lang, filename);
    const contextBlock = await (0, context_1.buildContextBlock)(document, range, config.includeRelatedFile, config.includeDiagnostics);
    const symbolsBlock = workspaceIndex
        ? (0, indexer_1.formatSymbolsBlock)((0, indexer_1.findRelevantSymbols)(selectedText, workspaceIndex))
        : "";
    const userContent = `${contextBlock}${symbolsBlock}\n\nFix this ${lang} code:\n\`\`\`\n${selectedText}\n\`\`\``;
    await applyActionToSelection(document, range, system, userContent);
}
async function runEdit(document, range) {
    const selectedText = document.getText(range);
    if (!selectedText.trim()) {
        vscode.window.showWarningMessage("PM LLM: select some code first.");
        return;
    }
    const lang = document.languageId ?? "code";
    const filename = document.fileName.split(/[\\/]/).pop() ?? "unknown";
    const instruction = await vscode.window.showInputBox({
        prompt: "Describe the edit to apply",
        placeHolder: "e.g. add null checks, convert to async/await, add JSDoc comments…",
    });
    if (!instruction)
        return;
    const system = (0, prompts_1.buildEditSystemPrompt)(lang, filename);
    const contextBlock = await (0, context_1.buildContextBlock)(document, range, config.includeRelatedFile, false);
    const symbolsBlock = workspaceIndex
        ? (0, indexer_1.formatSymbolsBlock)((0, indexer_1.findRelevantSymbols)(selectedText, workspaceIndex))
        : "";
    const userContent = `${contextBlock}${symbolsBlock}\n\nInstruction: ${instruction}\n\nCode:\n\`\`\`\n${selectedText}\n\`\`\``;
    await applyActionToSelection(document, range, system, userContent);
}
// ─── Activate ─────────────────────────────────────────────────────────────────
function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "pmAutocomplete.toggle";
    statusBarItem.tooltip = "PM Autocomplete — click to toggle";
    syncStatusBar();
    // Load or build workspace index
    ensureIndex();
    // ─── Chat Participant Registration (Fase 1) ────────────────────────────────
    const participant = vscode.chat.createChatParticipant("pmAutocomplete.chat", chatParticipant_1.handleChatRequest);
    // Re-index on file save (debounced — only TS/CS files)
    const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
        const ext = doc.fileName.split(".").pop()?.toLowerCase();
        if (ext === "ts" || ext === "cs") {
            rebuildIndex();
        }
    });
    // Manual re-index command
    const reindexCmd = vscode.commands.registerCommand("pmAutocomplete.reindex", async () => {
        updateStatusBar("$(loading~spin) Indexing…");
        await rebuildIndex();
        syncStatusBar();
        vscode.window.showInformationMessage(`PM LLM: index built — ${workspaceIndex?.symbols.length ?? 0} symbols`);
    });
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("pmAutocomplete") ||
            e.affectsConfiguration("pmChat")) {
            config = (0, config_1.loadConfig)();
            syncStatusBar();
        }
    });
    const toggleCmd = vscode.commands.registerCommand("pmAutocomplete.toggle", () => {
        const cfg = vscode.workspace.getConfiguration("pmAutocomplete");
        const current = cfg.get("enabled", true);
        cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`PM Autocomplete: ${!current ? "ON" : "OFF"}`);
    });
    // Fase 4 — apply delle modifiche proposte in chat, solo al click sul bottone
    const applyEditCmd = vscode.commands.registerCommand("pmAutocomplete.applyEdit", async (edits) => {
        if (!Array.isArray(edits) || edits.length === 0)
            return;
        const ok = await (0, edits_1.applyProposedEdits)(edits);
        if (ok) {
            vscode.window.showInformationMessage(`PM LLM: modifiche applicate (${edits.length} file).`);
        }
        else {
            vscode.window.showWarningMessage("PM LLM: apply non riuscito o annullato.");
        }
    });
    const openChatCmd = vscode.commands.registerCommand("pmChat.open", () => {
        // Apre il pannello chat e inserisce @pm automaticamente (UX enhancement)
        vscode.commands.executeCommand("workbench.action.chat.open");
    });
    const fixCmd = vscode.commands.registerCommand("pmAutocomplete.fix", (doc, range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const d = doc ?? editor.document;
        const r = range ??
            (editor.selection.isEmpty
                ? editor.document.lineAt(editor.selection.active.line).range
                : editor.selection);
        runFix(d, r);
    });
    const editCmd = vscode.commands.registerCommand("pmAutocomplete.edit", (doc, range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const d = doc ?? editor.document;
        const r = range ??
            (editor.selection.isEmpty
                ? editor.document.lineAt(editor.selection.active.line).range
                : editor.selection);
        runEdit(d, r);
    });
    const inlineProvider = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, new LlamaInlineProvider());
    const codeActionProvider = vscode.languages.registerCodeActionsProvider({ pattern: "**" }, new LlamaCodeActionProvider(), {
        providedCodeActionKinds: LlamaCodeActionProvider.providedCodeActionKinds,
    });
    context.subscriptions.push(participant, inlineProvider, codeActionProvider, toggleCmd, openChatCmd, applyEditCmd, fixCmd, editCmd, reindexCmd, onSave, statusBarItem, configWatcher);
    console.log("[PM Autocomplete] Active — server:", config.serverUrl);
}
function deactivate() {
    if (debounceTimer)
        clearTimeout(debounceTimer);
    (0, api_1.abortActiveRequests)();
    (0, chatPanel_1.disposeChatPanel)();
}
