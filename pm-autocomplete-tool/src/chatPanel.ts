import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getNonce } from './utils';
import { ChatMessage, streamChat } from './api';
import { ExtensionConfig, MAX_FILE_CONTEXT } from './config';

export let chatPanel: vscode.WebviewPanel | undefined;

const MAX_RECENT_MESSAGES = 14;
const SUMMARY_TRIGGER     = 20;
const SUMMARY_FILENAME    = '.pm_context_summary.json';

// ─── Summary persistence ──────────────────────────────────────────────────────

function getSummaryPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return path.join(folders[0].uri.fsPath, SUMMARY_FILENAME);
}

function loadSummaryFromDisk(): string {
  const filePath = getSummaryPath();
  if (!filePath) return '';
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as { summary?: string; savedAt?: string };
    return data.summary ?? '';
  } catch {
    return '';
  }
}


function saveSummaryToDisk(summary: string): void {
  const filePath = getSummaryPath();
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      summary,
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (e) {
    console.error('[PM Chat] Failed to save summary:', e);
  }
}

// ─── Summary generation ───────────────────────────────────────────────────────

async function generateSummary(
  messages: ChatMessage[],
  endpoint: string,
  model: string
): Promise<string> {
  const transcript = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const summaryMessages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a concise summarizer. Summarize the following conversation in 3-5 bullet points, preserving key technical decisions, file names, and unresolved issues. Output plain text only.',
    },
    { role: 'user', content: `Conversation to summarize:\n\n${transcript}` },
  ];

  return new Promise((resolve) => {
    let result = '';
    streamChat(
      summaryMessages, endpoint, model,
      (chunk) => { result = chunk; },
      () => resolve(result || '(no summary generated)'),
      () => resolve('(summary failed)')
    );
  });
}

// ─── Context window ───────────────────────────────────────────────────────────

function buildContextWindow(
  systemPrompt: string,
  sessionSummary: string,
  fullHistory: ChatMessage[]
): ChatMessage[] {
  const window: ChatMessage[] = [];
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

export function createChatPanel(context: vscode.ExtensionContext, getConfig: () => ExtensionConfig): void {
  if (chatPanel) { chatPanel.reveal(vscode.ViewColumn.Two); return; }

  chatPanel = vscode.window.createWebviewPanel(
    'pmChat', 'PM Chat',
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const nonce  = getNonce();
  const config = getConfig();

  const htmlPath = path.join(context.extensionPath, 'src', 'chat.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/\{\{NONCE\}\}/g, nonce);
  chatPanel.webview.html = html;

  const fullHistory: ChatMessage[] = [];
  let assistantTurnCount = 0;

  // Load summary from disk on open — persists across VS Code sessions
  let sessionSummary = loadSummaryFromDisk();
  if (sessionSummary) {
    console.log('[PM Chat] Loaded summary from disk:', sessionSummary.slice(0, 80));
  }

  chatPanel.webview.onDidReceiveMessage(async msg => {
    if (!chatPanel) return;
    const currentConfig = getConfig();
	
	if (msg.type === 'reindex') {
	await vscode.commands.executeCommand('pmAutocomplete.reindex');
	}
	
	if (msg.type === 'injectIndex') {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    chatPanel.webview.postMessage({ type: 'error', text: 'No workspace open.' });
    return;
  }
  const indexPath = path.join(root, '.pm_workspace_index.json');
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(raw) as { builtAt: string; symbols: unknown[] };
    const summary = `Workspace index (${index.symbols.length} symbols, built ${index.builtAt}):\n\`\`\`json\n${raw.slice(0, 4000)}\n\`\`\``;
    fullHistory.push({ role: 'user', content: summary });
    fullHistory.push({ role: 'assistant', content: `Got it. I have the workspace index with ${index.symbols.length} symbols. I'll use it to provide more accurate context-aware suggestions.` });
    chatPanel.webview.postMessage({
      type: 'summary',
      text: `Workspace index loaded: ${index.symbols.length} symbols (${index.builtAt.slice(0, 10)})`
    });
  } catch {
    chatPanel.webview.postMessage({ type: 'error', text: 'Index not found. Run PM LLM: Rebuild Workspace Index first.' });
  }
}

    if (msg.type === 'send') {
      const userText: string = msg.text;
      fullHistory.push({ role: 'user', content: userText });

      const contextWindow = buildContextWindow(
        currentConfig.chatSystemPrompt,
        sessionSummary,
        fullHistory
      );

      let assistantText = '';
      await streamChat(
        contextWindow,
        currentConfig.chatEndpoint,
        currentConfig.chatModel,
        (chunk) => {
          assistantText = chunk;
          chatPanel?.webview.postMessage({ type: 'chunk', text: chunk });
        },
        async () => {
          if (assistantText) {
            fullHistory.push({ role: 'assistant', content: assistantText });
            assistantTurnCount++;
          }
          chatPanel?.webview.postMessage({ type: 'done' });

          // Auto-generate and persist summary every SUMMARY_TRIGGER turns
          if (assistantTurnCount > 0 && assistantTurnCount % SUMMARY_TRIGGER === 0) {
            sessionSummary = await generateSummary(fullHistory, currentConfig.chatEndpoint, currentConfig.chatModel);
            saveSummaryToDisk(sessionSummary);
            console.log('[PM Chat] Summary auto-saved to disk');
          }
        },
        (errMsg) => {
          fullHistory.pop();
          chatPanel?.webview.postMessage({ type: 'error', text: errMsg });
        }
      );
    }

    if (msg.type === 'clear') {
      fullHistory.length = 0;
      sessionSummary     = '';
      assistantTurnCount = 0;
      // Delete summary file on clear
      const fp = getSummaryPath();
      if (fp) { try { fs.unlinkSync(fp); } catch { /* ignore */ } }
      chatPanel.webview.postMessage({ type: 'cleared' });
    }

    if (msg.type === 'requestSummary') {
      if (fullHistory.filter(m => m.role !== 'system').length === 0) {
        chatPanel.webview.postMessage({ type: 'error', text: 'No conversation to summarize yet.' });
        return;
      }
      chatPanel.webview.postMessage({ type: 'chunk', text: 'Generating summary…' });
      sessionSummary = await generateSummary(fullHistory, currentConfig.chatEndpoint, currentConfig.chatModel);
      saveSummaryToDisk(sessionSummary);
      chatPanel.webview.postMessage({ type: 'done' });
      chatPanel.webview.postMessage({ type: 'summary', text: sessionSummary });
    }

    if (msg.type === 'injectFile') {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        chatPanel.webview.postMessage({ type: 'error', text: 'No active file in editor.' });
        return;
      }
      const doc      = editor.document;
      let content    = doc.getText();
      if (content.length > MAX_FILE_CONTEXT) content = content.slice(0, MAX_FILE_CONTEXT) + '\n... [truncated]';
      const filename = doc.fileName.split(/[\\/]/).pop() ?? 'file';
      const lang     = doc.languageId;

      fullHistory.push({
        role: 'user',
        content: `Here is the current file (${filename}):\n\`\`\`${lang}\n${content}\n\`\`\``,
      });
      fullHistory.push({
        role: 'assistant',
        content: `Got it. I have the content of \`${filename}\`. What would you like to do with it?`,
      });

      chatPanel.webview.postMessage({ type: 'injected', filename });
    }
  }, undefined, context.subscriptions);

  chatPanel.onDidDispose(() => { chatPanel = undefined; }, undefined, context.subscriptions);
}

export function disposeChatPanel() {
  chatPanel?.dispose();
}
