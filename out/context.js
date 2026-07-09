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
exports.findRelatedFile = findRelatedFile;
exports.getDiagnosticsForRange = getDiagnosticsForRange;
exports.buildContextBlock = buildContextBlock;
const vscode = __importStar(require("vscode"));
const MAX_RELATED_FILE_CHARS = 2500;
/**
 * Given a document, try to find its "sibling" file based on common naming
 * conventions (Angular component pairs, etc.) and return its content.
 *
 * Examples:
 *   home.component.ts   ↔ home.component.html
 *   home.component.ts   ↔ home.component.scss / .css
 *   auth.service.ts      ↔ auth.service.interface.ts (best-effort)
 */
async function findRelatedFile(document) {
    const filePath = document.uri.fsPath;
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const base = filePath.slice(0, filePath.lastIndexOf('.'));
    // Candidate sibling extensions based on the current file's extension
    let candidates = [];
    if (ext === '.ts') {
        candidates = ['.html', '.scss', '.css', '.less'];
    }
    else if (ext === '.html') {
        candidates = ['.ts'];
    }
    else if (ext === '.scss' || ext === '.css' || ext === '.less') {
        candidates = ['.ts'];
    }
    else {
        return null; // no known sibling convention for this file type
    }
    for (const candExt of candidates) {
        const candPath = base + candExt;
        try {
            const uri = vscode.Uri.file(candPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            let content = doc.getText();
            if (content.length > MAX_RELATED_FILE_CHARS) {
                content = content.slice(0, MAX_RELATED_FILE_CHARS) + '\n... [truncated]';
            }
            const filename = candPath.split(/[\\/]/).pop() ?? candPath;
            return { filename, content };
        }
        catch {
            // file doesn't exist, try next candidate
        }
    }
    return null;
}
/**
 * Collect active diagnostics (errors/warnings) that overlap the given range.
 * Returns a formatted string suitable for inclusion in a prompt, or null if none.
 */
function getDiagnosticsForRange(document, range) {
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    if (diagnostics.length === 0)
        return null;
    const relevant = diagnostics.filter(d => d.range.intersection(range) !== undefined);
    // Fallback: if nothing overlaps exactly, include diagnostics on the same lines
    const candidates = relevant.length > 0
        ? relevant
        : diagnostics.filter(d => d.range.start.line >= range.start.line - 2 && d.range.start.line <= range.end.line + 2);
    if (candidates.length === 0)
        return null;
    const lines = candidates.map(d => {
        const sev = vscode.DiagnosticSeverity[d.severity];
        const src = d.source ? `[${d.source}] ` : '';
        return `Line ${d.range.start.line + 1}: ${sev} ${src}${d.message}`;
    });
    return lines.join('\n');
}
/**
 * Build the full context block to prepend to a Fix/Edit prompt.
 * Includes filename, related sibling file content, and diagnostics if available.
 */
async function buildContextBlock(document, range, includeRelatedFile, includeDiagnostics) {
    const parts = [];
    const filename = document.fileName.split(/[\\/]/).pop() ?? 'unknown';
    parts.push(`File: ${filename}`);
    if (includeDiagnostics) {
        const diag = getDiagnosticsForRange(document, range);
        if (diag) {
            parts.push(`\nActive diagnostics on/near this selection:\n${diag}`);
        }
    }
    if (includeRelatedFile) {
        const related = await findRelatedFile(document);
        if (related) {
            const lang = related.filename.split('.').pop();
            parts.push(`\nRelated file (${related.filename}) for context — do not modify unless asked:\n\`\`\`${lang}\n${related.content}\n\`\`\``);
        }
    }
    return parts.join('\n');
}
