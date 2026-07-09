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
exports.parseFileEdits = parseFileEdits;
exports.applyProposedEdits = applyProposedEdits;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
/**
 * Estrae dalla risposta del modello i code block con marker di file
 * (convenzione: ```linguaggio:percorso/relativo.ext — vedi EDIT_FORMAT_INSTRUCTION).
 * I blocchi senza `:percorso` nell'info string vengono ignorati.
 * Se lo stesso file compare più volte, vince l'ultimo blocco.
 */
function parseFileEdits(text) {
    const byPath = new Map();
    const re = /```[a-zA-Z0-9#+.-]*:([^\n`]+)\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const filePath = m[1].trim().replace(/\\/g, '/');
        const content = m[2].replace(/\r?\n$/, '');
        if (!filePath || !isSafeRelativePath(filePath))
            continue;
        byPath.set(filePath, { filePath, content });
    }
    return [...byPath.values()];
}
/** Rifiuta path assoluti o con traversal (..) — il modello deve restare dentro il workspace. */
function isSafeRelativePath(p) {
    if (path.isAbsolute(p))
        return false;
    const normalized = path.normalize(p).replace(/\\/g, '/');
    return !normalized.startsWith('..') && !normalized.includes('/../');
}
function toUri(edit, root) {
    return path.isAbsolute(edit.filePath)
        ? vscode.Uri.file(edit.filePath)
        : vscode.Uri.joinPath(root, edit.filePath);
}
/**
 * Applica le modifiche proposte con un unico vscode.WorkspaceEdit
 * (quindi un solo undo, e supporto multi-file nativo).
 */
async function applyProposedEdits(edits) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        vscode.window.showWarningMessage('PM LLM: nessun workspace aperto, impossibile applicare le modifiche.');
        return false;
    }
    const wsEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
        const uri = toUri(edit, root);
        if (edit.range) {
            const r = edit.range;
            wsEdit.replace(uri, new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar), edit.content);
            continue;
        }
        // Sostituzione intero file: se esiste rimpiazza tutto, altrimenti crealo
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
            wsEdit.replace(uri, fullRange, edit.content);
        }
        catch {
            wsEdit.createFile(uri, { ignoreIfExists: true });
            wsEdit.insert(uri, new vscode.Position(0, 0), edit.content);
        }
    }
    return vscode.workspace.applyEdit(wsEdit);
}
