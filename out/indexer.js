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
exports.buildIndex = buildIndex;
exports.saveIndex = saveIndex;
exports.loadIndex = loadIndex;
exports.findRelevantSymbols = findRelevantSymbols;
exports.formatSymbolsBlock = formatSymbolsBlock;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const INDEX_FILENAME = '.pm_workspace_index.json';
// ─── Extraction helpers ───────────────────────────────────────────────────────
/** Extract Angular/TypeScript symbols from a .ts file */
function extractTsSymbols(content, relPath) {
    const symbols = [];
    const lines = content.split('\n');
    const patterns = [
        { re: /^\s*@Component\s*\(/, kind: 'component' },
        { re: /^\s*@Injectable\s*\(/, kind: 'service' },
        { re: /^\s*@Directive\s*\(/, kind: 'directive' },
        { re: /^\s*@Pipe\s*\(/, kind: 'pipe' },
        { re: /^\s*export\s+interface\s+(\w+)/, kind: 'interface' },
        { re: /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
        { re: /^\s*export\s+type\s+(\w+)/, kind: 'type' },
        { re: /^\s*(?:public\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/, kind: 'method' },
        // Signals
        { re: /^\s*(?:public\s+|readonly\s+)?(\w+)\s*=\s*signal\s*[<(]/, kind: 'signal' },
        { re: /^\s*(?:public\s+|readonly\s+)?(\w+)\s*=\s*computed\s*\(/, kind: 'computed' },
        // Input/Output
        { re: /^\s*@Input\s*\(\)/, kind: 'input' },
        { re: /^\s*@Output\s*\(\)/, kind: 'output' },
    ];
    // Decorator context — when we find @Component etc., next class declaration is the name
    let pendingKind = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { re, kind } of patterns) {
            const m = line.match(re);
            if (!m)
                continue;
            if (['component', 'service', 'directive', 'pipe', 'input', 'output'].includes(kind)) {
                pendingKind = kind;
                break;
            }
            // For class/interface/type/method/signal, extract name directly
            const nameMatch = line.match(/(?:class|interface|type|function)\s+(\w+)/) ||
                line.match(/(?:export\s+)?(?:const\s+|let\s+|var\s+)?(\w+)\s*[=:(]/);
            const name = nameMatch?.[1] ?? m[1] ?? '?';
            symbols.push({
                name,
                kind: pendingKind ?? kind,
                file: relPath,
                line: i + 1,
                preview: line.trim().slice(0, 120),
            });
            pendingKind = null;
            break;
        }
        // Resolve pending decorator kind with the class name on the next class line
        if (pendingKind) {
            const classMatch = line.match(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/);
            if (classMatch) {
                symbols.push({
                    name: classMatch[1],
                    kind: pendingKind,
                    file: relPath,
                    line: i + 1,
                    preview: line.trim().slice(0, 120),
                });
                pendingKind = null;
            }
        }
    }
    return symbols;
}
/** Extract C# symbols from a .cs file */
function extractCsSymbols(content, relPath) {
    const symbols = [];
    const lines = content.split('\n');
    const patterns = [
        { re: /^\s*(?:public|internal|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
        { re: /^\s*(?:public|internal)?\s*(?:partial\s+)?interface\s+(\w+)/, kind: 'interface' },
        { re: /^\s*(?:public|internal)?\s*(?:sealed\s+)?record\s+(\w+)/, kind: 'record' },
        { re: /^\s*(?:public|internal)?\s*enum\s+(\w+)/, kind: 'enum' },
        // Minimal API endpoints
        { re: /\.(MapGet|MapPost|MapPut|MapDelete|MapPatch)\s*\(\s*["']([^"']+)["']/, kind: 'endpoint' },
        // Controller actions
        { re: /^\s*\[Http(Get|Post|Put|Delete|Patch)\]/, kind: 'endpoint' },
        // Public methods
        { re: /^\s*public\s+(?:async\s+)?(?:Task<?[^>]*>?|void|\w+)\s+(\w+)\s*\(/, kind: 'method' },
        // Constructor injection hints (interfaces)
        { re: /^\s*private\s+(?:readonly\s+)?(\w*(?:Service|Repository|Interface)\w*)\s+/, kind: 'dependency' },
    ];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { re, kind } of patterns) {
            const m = line.match(re);
            if (!m)
                continue;
            const name = m[2] ?? m[1] ?? line.trim().slice(0, 40);
            symbols.push({
                name,
                kind,
                file: relPath,
                line: i + 1,
                preview: line.trim().slice(0, 120),
            });
            break;
        }
    }
    return symbols;
}
// ─── Indexer ──────────────────────────────────────────────────────────────────
const INCLUDE_GLOBS = ['**/*.ts', '**/*.cs', '**/*.html'];
const EXCLUDE_GLOBS = '**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/bin/**,**/obj/**';
const MAX_FILE_SIZE = 200 * 1024; // 200KB — skip huge generated files
async function buildIndex(workspaceRoot) {
    const index = { builtAt: new Date().toISOString(), symbols: [] };
    for (const glob of INCLUDE_GLOBS) {
        const uris = await vscode.workspace.findFiles(glob, `{${EXCLUDE_GLOBS}}`);
        for (const uri of uris) {
            try {
                const stat = fs.statSync(uri.fsPath);
                if (stat.size > MAX_FILE_SIZE)
                    continue;
                const content = fs.readFileSync(uri.fsPath, 'utf8');
                const relPath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                const ext = path.extname(uri.fsPath).toLowerCase();
                let symbols = [];
                if (ext === '.ts')
                    symbols = extractTsSymbols(content, relPath);
                else if (ext === '.cs')
                    symbols = extractCsSymbols(content, relPath);
                // .html skipped for now — rarely needed for symbol lookup
                index.symbols.push(...symbols);
            }
            catch { /* skip unreadable files */ }
        }
    }
    return index;
}
function saveIndex(index, workspaceRoot) {
    const filePath = path.join(workspaceRoot, INDEX_FILENAME);
    try {
        fs.writeFileSync(filePath, JSON.stringify(index, null, 2), 'utf8');
    }
    catch (e) {
        console.error('[PM Indexer] Failed to save index:', e);
    }
}
function loadIndex(workspaceRoot) {
    const filePath = path.join(workspaceRoot, INDEX_FILENAME);
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Find symbols relevant to the given code snippet.
 * Simple strategy: look for identifiers in the code that match symbol names in the index.
 */
function findRelevantSymbols(code, index, maxResults = 8) {
    // Extract candidate identifiers from the code (PascalCase and camelCase words, length > 3)
    const identifiers = new Set((code.match(/\b[A-Za-z][a-zA-Z0-9]{3,}\b/g) ?? [])
        .filter(w => /[A-Z]/.test(w)) // at least one uppercase — likely a type/class name
    );
    if (identifiers.size === 0)
        return [];
    const scored = [];
    for (const entry of index.symbols) {
        if (identifiers.has(entry.name)) {
            // Higher score for interfaces and classes (more useful as context)
            const kindScore = ['interface', 'class', 'record', 'service', 'component'].includes(entry.kind) ? 2 : 1;
            scored.push({ entry, score: kindScore });
        }
    }
    // Sort by score desc, deduplicate by name
    const seen = new Set();
    return scored
        .sort((a, b) => b.score - a.score)
        .filter(({ entry }) => {
        if (seen.has(entry.name))
            return false;
        seen.add(entry.name);
        return true;
    })
        .slice(0, maxResults)
        .map(({ entry }) => entry);
}
/**
 * Format relevant symbols as a context block for the LLM prompt.
 */
function formatSymbolsBlock(symbols) {
    if (symbols.length === 0)
        return '';
    const lines = symbols.map(s => `- ${s.kind} \`${s.name}\` in ${s.file}:${s.line} — ${s.preview}`);
    return `\nProject symbols referenced in this code:\n${lines.join('\n')}`;
}
