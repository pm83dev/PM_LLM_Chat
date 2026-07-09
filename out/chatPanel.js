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
exports.chatPanel = void 0;
exports.createChatPanel = createChatPanel;
exports.disposeChatPanel = disposeChatPanel;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const utils_1 = require("./utils");
const api_1 = require("./api");
const config_1 = require("./config");
const MAX_RECENT_MESSAGES = 14;
const SUMMARY_TRIGGER = 20;
const SUMMARY_FILENAME = '.pm_context_summary.json';
// ─── Summary persistence ──────────────────────────────────────────────────────
function getSummaryPath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0)
        return null;
    return path.join(folders[0].uri.fsPath, SUMMARY_FILENAME);
}
function loadSummaryFromDisk() {
    const filePath = getSummaryPath();
    if (!filePath)
        return '';
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        return data.summary ?? '';
    }
    catch {
        return '';
    }
}
function saveSummaryToDisk(summary) {
    const filePath = getSummaryPath();
    if (!filePath)
        return;
    try {
        fs.writeFileSync(filePath, JSON.stringify({
            summary,
            savedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
    }
    catch (e) {
        console.error('[PM Chat] Failed to save summary:', e);
    }
}
// ─── Summary generation ───────────────────────────────────────────────────────
async function generateSummary(messages, endpoint, model) {
    const transcript = messages
        .filter(m => m.role !== 'system')
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');
    const summaryMessages = [
        {
            role: 'system',
            content: 'You are a concise summarizer. Summarize the following conversation in 3-5 bullet points, preserving key technical decisions, file names, and unresolved issues. Output plain text only.',
        },
        { role: 'user', content: `Conversation to summarize:\n\n${transcript}` },
    ];
    return new Promise((resolve) => {
        let result = '';
        (0, api_1.streamChat)(summaryMessages, endpoint, model, (chunk) => { result = chunk; }, () => resolve(result || '(no summary generated)'), () => resolve('(summary failed)'));
    });
}
// ─── Context window ───────────────────────────────────────────────────────────
function buildContextWindow(systemPrompt, sessionSummary, fullHistory) {
    const window = [];
    window.push({ role: 'system', content: systemPrompt });
    if (sessionSummary) {
        window.push({
            role: 'system',
            content: `[SESSION SUMMARY — earlier conversation]\n${sessionSummary}`,
        });
    }
    const recent = fullHistory
        .filter(m => m.role !== 'system')
        .slice(-MAX_RECENT_MESSAGES);
    window.push(...recent);
    return window;
}
// ─── Panel ────────────────────────────────────────────────────────────────────
function createChatPanel(context, getConfig) {
    if (exports.chatPanel) {
        exports.chatPanel.reveal(vscode.ViewColumn.Two);
        return;
    }
    exports.chatPanel = vscode.window.createWebviewPanel('pmChat', 'PM Chat', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    const nonce = (0, utils_1.getNonce)();
    const config = getConfig();
    const htmlPath = path.join(context.extensionPath, 'src', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\{\{NONCE\}\}/g, nonce);
    exports.chatPanel.webview.html = html;
    const fullHistory = [];
    let assistantTurnCount = 0;
    // Load summary from disk on open — persists across VS Code sessions
    let sessionSummary = loadSummaryFromDisk();
    if (sessionSummary) {
        console.log('[PM Chat] Loaded summary from disk:', sessionSummary.slice(0, 80));
    }
    exports.chatPanel.webview.onDidReceiveMessage(async (msg) => {
        if (!exports.chatPanel)
            return;
        const currentConfig = getConfig();
        if (msg.type === 'reindex') {
            await vscode.commands.executeCommand('pmAutocomplete.reindex');
        }
        if (msg.type === 'injectIndex') {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) {
                exports.chatPanel.webview.postMessage({ type: 'error', text: 'No workspace open.' });
                return;
            }
            const indexPath = path.join(root, '.pm_workspace_index.json');
            try {
                const raw = fs.readFileSync(indexPath, 'utf8');
                const index = JSON.parse(raw);
                const summary = `Workspace index (${index.symbols.length} symbols, built ${index.builtAt}):\n\`\`\`json\n${raw.slice(0, 4000)}\n\`\`\``;
                fullHistory.push({ role: 'user', content: summary });
                fullHistory.push({ role: 'assistant', content: `Got it. I have the workspace index with ${index.symbols.length} symbols. I'll use it to provide more accurate context-aware suggestions.` });
                exports.chatPanel.webview.postMessage({
                    type: 'summary',
                    text: `Workspace index loaded: ${index.symbols.length} symbols (${index.builtAt.slice(0, 10)})`
                });
            }
            catch {
                exports.chatPanel.webview.postMessage({ type: 'error', text: 'Index not found. Run PM LLM: Rebuild Workspace Index first.' });
            }
        }
        if (msg.type === 'send') {
            const userText = msg.text;
            fullHistory.push({ role: 'user', content: userText });
            const contextWindow = buildContextWindow(currentConfig.chatSystemPrompt, sessionSummary, fullHistory);
            let assistantText = '';
            await (0, api_1.streamChat)(contextWindow, currentConfig.chatEndpoint, currentConfig.chatModel, (chunk) => {
                assistantText = chunk;
                exports.chatPanel?.webview.postMessage({ type: 'chunk', text: chunk });
            }, async () => {
                if (assistantText) {
                    fullHistory.push({ role: 'assistant', content: assistantText });
                    assistantTurnCount++;
                }
                exports.chatPanel?.webview.postMessage({ type: 'done' });
                // Auto-generate and persist summary every SUMMARY_TRIGGER turns
                if (assistantTurnCount > 0 && assistantTurnCount % SUMMARY_TRIGGER === 0) {
                    sessionSummary = await generateSummary(fullHistory, currentConfig.chatEndpoint, currentConfig.chatModel);
                    saveSummaryToDisk(sessionSummary);
                    console.log('[PM Chat] Summary auto-saved to disk');
                }
            }, (errMsg) => {
                fullHistory.pop();
                exports.chatPanel?.webview.postMessage({ type: 'error', text: errMsg });
            });
        }
        if (msg.type === 'clear') {
            fullHistory.length = 0;
            sessionSummary = '';
            assistantTurnCount = 0;
            // Delete summary file on clear
            const fp = getSummaryPath();
            if (fp) {
                try {
                    fs.unlinkSync(fp);
                }
                catch { /* ignore */ }
            }
            exports.chatPanel.webview.postMessage({ type: 'cleared' });
        }
        if (msg.type === 'requestSummary') {
            if (fullHistory.filter(m => m.role !== 'system').length === 0) {
                exports.chatPanel.webview.postMessage({ type: 'error', text: 'No conversation to summarize yet.' });
                return;
            }
            exports.chatPanel.webview.postMessage({ type: 'chunk', text: 'Generating summary…' });
            sessionSummary = await generateSummary(fullHistory, currentConfig.chatEndpoint, currentConfig.chatModel);
            saveSummaryToDisk(sessionSummary);
            exports.chatPanel.webview.postMessage({ type: 'done' });
            exports.chatPanel.webview.postMessage({ type: 'summary', text: sessionSummary });
        }
        if (msg.type === 'injectFile') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                exports.chatPanel.webview.postMessage({ type: 'error', text: 'No active file in editor.' });
                return;
            }
            const doc = editor.document;
            let content = doc.getText();
            if (content.length > config_1.MAX_FILE_CONTEXT)
                content = content.slice(0, config_1.MAX_FILE_CONTEXT) + '\n... [truncated]';
            const filename = doc.fileName.split(/[\\/]/).pop() ?? 'file';
            const lang = doc.languageId;
            fullHistory.push({
                role: 'user',
                content: `Here is the current file (${filename}):\n\`\`\`${lang}\n${content}\n\`\`\``,
            });
            fullHistory.push({
                role: 'assistant',
                content: `Got it. I have the content of \`${filename}\`. What would you like to do with it?`,
            });
            exports.chatPanel.webview.postMessage({ type: 'injected', filename });
        }
    }, undefined, context.subscriptions);
    exports.chatPanel.onDidDispose(() => { exports.chatPanel = undefined; }, undefined, context.subscriptions);
}
function disposeChatPanel() {
    exports.chatPanel?.dispose();
}
