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
exports.handleChatRequest = handleChatRequest;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
const config_1 = require("./config");
const context_1 = require("./context");
const edits_1 = require("./edits");
const indexer_1 = require("./indexer");
const prompts_1 = require("./prompts");
const utils_1 = require("./utils");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Costanti di configurazione locali per evitare dipendenze circolari o accoppiamento stretto
const SUMMARY_FILENAME = '.pm_context_summary.json';
const MAX_CONTEXT_CHARS = 3000; // Soglia simile a quella usata in chatPanel.ts per inject file
const MAX_REFERENCE_CHARS = 3000; // Cap per ogni file referenziato con #file
/**
 * Carica il summary dalla disk se presente.
 */
function loadSessionSummary() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0)
        return null;
    const filePath = path.join(folders[0].uri.fsPath, SUMMARY_FILENAME);
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        return data.summary ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Carica il Workspace Index da disco (se presente).
 */
function loadWorkspaceIndex() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0)
        return null;
    return (0, indexer_1.loadIndex)(folders[0].uri.fsPath);
}
/**
 * Costruisce il contesto automatico per la chat.
 * Include: File attivo, file gemello (se esiste), simboli rilevanti dall'indice.
 */
async function buildAutoContext(prompt, workspaceIndex) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return '';
    const document = editor.document;
    // 1. Contesto del file attivo e gemello (riusa la logica di context.ts ma adattata per chat)
    let contextBlock = '';
    try {
        // buildContextBlock richiede un range, usiamo il documento intero o una selezione se presente
        const selectionRange = editor.selection.isEmpty
            ? new vscode.Range(0, 0, document.lineCount, 0)
            : editor.selection;
        const rawContext = await (0, context_1.buildContextBlock)(document, selectionRange, true, false); // includeRelatedFile=true, diagnostics=false per chat
        if (rawContext && rawContext.length > MAX_CONTEXT_CHARS) {
            contextBlock = rawContext.slice(0, MAX_CONTEXT_CHARS) + '... [context truncated]';
        }
        else {
            contextBlock = rawContext;
        }
    }
    catch (e) {
        console.error('[PM Chat Participant] Error building auto-context:', e);
    }
    // 2. Simboli rilevanti dall'indice workspace (Code RAG)
    let symbolsBlock = '';
    if (workspaceIndex && prompt.length > 0) {
        const relevantSymbols = (0, indexer_1.findRelevantSymbols)(prompt, workspaceIndex, 5); // Max 5 simboli per non gonfiare troppo
        symbolsBlock = (0, indexer_1.formatSymbolsBlock)(relevantSymbols);
    }
    return `${contextBlock}${symbolsBlock}`;
}
/**
 * Fase 3 — #file references native.
 * Legge request.references (file trascinati o referenziati con #nomefile)
 * e li aggiunge al blocco di contesto. Deduplica il file attivo e il suo
 * gemello, già inclusi da buildContextBlock().
 */
async function collectReferencedFiles(request) {
    if (request.references.length === 0)
        return '';
    // Base path del file attivo senza estensione: copre sia il file stesso
    // sia i gemelli (.ts/.html/.scss condividono la base)
    const editor = vscode.window.activeTextEditor;
    const activeBase = editor
        ? editor.document.uri.fsPath.replace(/\.[^.\\/]+$/, '') + '.'
        : null;
    let out = '';
    for (const ref of request.references) {
        const value = ref.value;
        if (typeof value === 'string') {
            out += `\nReference:\n${value}\n`;
            continue;
        }
        let uri;
        if (value instanceof vscode.Uri) {
            uri = value;
        }
        else if (value instanceof vscode.Location) {
            uri = value.uri;
        }
        if (!uri)
            continue;
        // Deduplica: file attivo / gemello già inclusi dal contesto automatico
        if (activeBase && uri.fsPath.startsWith(activeBase.slice(0, -1)))
            continue;
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            let text = Buffer.from(bytes).toString('utf8');
            if (text.length > MAX_REFERENCE_CHARS) {
                text = text.slice(0, MAX_REFERENCE_CHARS) + '\n... [truncated]';
            }
            const filename = uri.path.split('/').pop() ?? uri.fsPath;
            const lang = filename.includes('.') ? filename.split('.').pop() : '';
            out += `\nReferenced file (${filename}):\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
        }
        catch {
            /* file non leggibile — skip */
        }
    }
    return out;
}
/**
 * Fase 5 — Slash commands /fix e /edit.
 * Riusa fetchAction() con la selezione attiva (stessa logica dei comandi
 * editor Ctrl+. / Ctrl+Shift+.) ma dentro il flusso chat: il risultato viene
 * mostrato come preview con bottone "Applica modifiche" (Fase 4) invece di
 * sostituire direttamente il testo.
 */
async function handleActionCommand(request, stream) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        stream.markdown('⚠️ Apri un file nell\'editor e seleziona il codice su cui lavorare.');
        return undefined;
    }
    const document = editor.document;
    const range = editor.selection.isEmpty
        ? document.lineAt(editor.selection.active.line).range
        : editor.selection;
    const selectedText = document.getText(range);
    if (!selectedText.trim()) {
        stream.markdown('⚠️ Seleziona del codice nell\'editor prima di usare questo comando.');
        return undefined;
    }
    if (request.command === 'edit' && !request.prompt.trim()) {
        stream.markdown('⚠️ Specifica l\'istruzione, es.: `@pm /edit converti in async/await`');
        return undefined;
    }
    const cfg = (0, config_1.loadConfig)();
    const lang = document.languageId ?? 'code';
    const filename = document.fileName.split(/[\\/]/).pop() ?? 'unknown';
    const system = request.command === 'fix'
        ? (0, prompts_1.buildFixSystemPrompt)(lang, filename)
        : (0, prompts_1.buildEditSystemPrompt)(lang, filename);
    const contextBlock = await (0, context_1.buildContextBlock)(document, range, cfg.includeRelatedFile, request.command === 'fix' ? cfg.includeDiagnostics : false);
    const workspaceIndex = loadWorkspaceIndex();
    const symbolsBlock = workspaceIndex
        ? (0, indexer_1.formatSymbolsBlock)((0, indexer_1.findRelevantSymbols)(selectedText, workspaceIndex))
        : '';
    const userContent = request.command === 'fix'
        ? `${contextBlock}${symbolsBlock}\n\nFix this ${lang} code:\n\`\`\`\n${selectedText}\n\`\`\``
        : `${contextBlock}${symbolsBlock}\n\nInstruction: ${request.prompt}\n\nCode:\n\`\`\`\n${selectedText}\n\`\`\``;
    stream.progress('Interrogo il modello…');
    const result = await (0, api_1.fetchAction)(system, userContent, cfg.actionServerUrl, cfg.serverUrl, cfg.actionModelFamily, cfg.actionMaxTokens, cfg.actionTimeoutMs);
    if (!result || result.trim().length === 0) {
        stream.markdown('⚠️ Nessun risultato dal server.');
        return undefined;
    }
    const clean = (0, utils_1.extractCode)(result);
    if (!clean) {
        stream.markdown('⚠️ Impossibile estrarre codice dalla risposta.');
        return undefined;
    }
    stream.markdown(`Modifica proposta per \`${filename}\` (righe ${range.start.line + 1}–${range.end.line + 1}):\n\n` +
        `\`\`\`${lang}\n${clean}\n\`\`\`\n`);
    const proposed = {
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
        command: 'pmAutocomplete.applyEdit',
        arguments: [[proposed]],
        title: 'Applica modifiche',
    });
    return undefined;
}
/**
 * Handler principale del Chat Participant.
 */
async function handleChatRequest(request, context, stream, token) {
    // Slash commands: /fix e /edit passano per fetchAction + preview/apply
    if (request.command === 'fix' || request.command === 'edit') {
        return handleActionCommand(request, stream);
    }
    // 1. Carica configurazione
    const config = vscode.workspace.getConfiguration('pmChat');
    const endpoint = config.get('endpoint', 'http://localhost:9000/v1/chat/completions');
    const model = config.get('model', 'gemma4');
    const systemPrompt = config.get('systemPrompt', 'You are an expert software developer.');
    const autoContextEnabled = config.get('autoContext', true);
    // 2. Carica Workspace Index (se disponibile)
    const workspaceIndex = loadWorkspaceIndex();
    // 3. Costruisci il contesto automatico (Fase 2) + #file references (Fase 3)
    const autoContext = autoContextEnabled
        ? await buildAutoContext(request.prompt, workspaceIndex)
        : '';
    const referencesBlock = await collectReferencedFiles(request);
    // 4. Gestisci Session Summary (solo al primo turno della conversazione)
    let sessionSummary = '';
    if (context.history.length === 0) {
        const loadedSummary = loadSessionSummary();
        if (loadedSummary) {
            sessionSummary = `[SESSION SUMMARY — earlier conversation]\n${loadedSummary}`;
        }
    }
    // 5. Costruisci i messaggi per l'API
    const messages = [];
    messages.push({ role: 'system', content: `${systemPrompt}\n\n${prompts_1.EDIT_FORMAT_INSTRUCTION}` });
    if (sessionSummary) {
        messages.push({ role: 'system', content: sessionSummary });
    }
    // Inietta contesto automatico + file referenziati prima del prompt utente
    const combinedContext = `${autoContext}${referencesBlock}`;
    if (combinedContext.trim().length > 0) {
        messages.push({
            role: 'user',
            content: `Here is the relevant context for this request:\n${combinedContext}`
        });
    }
    // Aggiungi la cronologia della chat precedente (limitata per risparmiare token)
    const recentHistory = context.history.slice(-10); // Ultimi 10 turni
    for (const turn of recentHistory) {
        if (turn instanceof vscode.ChatRequestTurn) {
            messages.push({ role: 'user', content: turn.prompt });
        }
        else if (turn instanceof vscode.ChatResponseTurn) {
            const text = turn.response
                .filter((part) => part instanceof vscode.ChatResponseMarkdownPart)
                .map((part) => part.value.value)
                .join('');
            if (text) {
                messages.push({ role: 'assistant', content: text });
            }
        }
    }
    messages.push({ role: 'user', content: request.prompt });
    // 6. Esegui lo streaming verso l'output del Chat Participant
    // Nota: streamChat passa a onChunk il testo cumulativo (già ripulito dai think-tag),
    // mentre stream.markdown() appende — quindi emettiamo solo il delta.
    let renderedLength = 0;
    let finalText = '';
    await (0, api_1.streamChat)(messages, endpoint, model, (fullText) => {
        finalText = fullText;
        const delta = fullText.slice(renderedLength);
        renderedLength = Math.max(renderedLength, fullText.length);
        if (delta)
            stream.markdown(delta);
    }, () => {
        console.log('[PM Chat Participant] Stream completed');
    }, (errorMsg) => {
        stream.markdown(`\n\n⚠️ **Error:** ${errorMsg}`);
    });
    // 7. Fase 4 — se la risposta contiene blocchi con marker di file
    // (```lang:percorso), proponi l'apply via WorkspaceEdit
    const proposedEdits = (0, edits_1.parseFileEdits)(finalText);
    if (proposedEdits.length > 0) {
        const fileList = proposedEdits.map((e) => `- \`${e.filePath}\``).join('\n');
        stream.markdown(`\n\n---\n📝 **Modifiche proposte** (${proposedEdits.length} file):\n${fileList}\n`);
        stream.button({
            command: 'pmAutocomplete.applyEdit',
            arguments: [proposedEdits],
            title: 'Applica modifiche',
        });
    }
    return undefined;
}
