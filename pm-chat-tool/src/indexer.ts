import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SymbolEntry {
  name:     string;
  kind:     string;   // 'component' | 'service' | 'interface' | 'class' | 'method' | 'endpoint' | ...
  file:     string;   // relative path from workspace root
  line:     number;
  preview:  string;   // first non-empty line of the definition (for context)
}

export interface WorkspaceIndex {
  builtAt:  string;
  symbols:  SymbolEntry[];
}

const INDEX_FILENAME = '.pm_workspace_index.json';

// ─── Extraction helpers ───────────────────────────────────────────────────────

/** Extract Angular/TypeScript symbols from a .ts file */
function extractTsSymbols(content: string, relPath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split('\n');

  const patterns: { re: RegExp; kind: string }[] = [
    { re: /^\s*@Component\s*\(/,                        kind: 'component' },
    { re: /^\s*@Injectable\s*\(/,                       kind: 'service'   },
    { re: /^\s*@Directive\s*\(/,                        kind: 'directive' },
    { re: /^\s*@Pipe\s*\(/,                             kind: 'pipe'      },
    { re: /^\s*export\s+interface\s+(\w+)/,             kind: 'interface' },
    { re: /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/, kind: 'class'    },
    { re: /^\s*export\s+type\s+(\w+)/,                  kind: 'type'      },
    { re: /^\s*(?:public\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/, kind: 'method' },
    // Signals
    { re: /^\s*(?:public\s+|readonly\s+)?(\w+)\s*=\s*signal\s*[<(]/, kind: 'signal' },
    { re: /^\s*(?:public\s+|readonly\s+)?(\w+)\s*=\s*computed\s*\(/, kind: 'computed' },
    // Input/Output
    { re: /^\s*@Input\s*\(\)/,  kind: 'input'  },
    { re: /^\s*@Output\s*\(\)/, kind: 'output' },
  ];

  // Decorator context — when we find @Component etc., next class declaration is the name
  let pendingKind: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const { re, kind } of patterns) {
      const m = line.match(re);
      if (!m) continue;

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
function extractCsSymbols(content: string, relPath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split('\n');

  const patterns: { re: RegExp; kind: string }[] = [
    { re: /^\s*(?:public|internal|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/,     kind: 'class'      },
    { re: /^\s*(?:public|internal)?\s*(?:partial\s+)?interface\s+(\w+)/,                                  kind: 'interface'  },
    { re: /^\s*(?:public|internal)?\s*(?:sealed\s+)?record\s+(\w+)/,                                      kind: 'record'     },
    { re: /^\s*(?:public|internal)?\s*enum\s+(\w+)/,                                                      kind: 'enum'       },
    // Minimal API endpoints
    { re: /\.(MapGet|MapPost|MapPut|MapDelete|MapPatch)\s*\(\s*["']([^"']+)["']/,                          kind: 'endpoint'   },
    // Controller actions
    { re: /^\s*\[Http(Get|Post|Put|Delete|Patch)\]/,                                                       kind: 'endpoint'   },
    // Public methods
    { re: /^\s*public\s+(?:async\s+)?(?:Task<?[^>]*>?|void|\w+)\s+(\w+)\s*\(/,                           kind: 'method'     },
    // Constructor injection hints (interfaces)
    { re: /^\s*private\s+(?:readonly\s+)?(\w*(?:Service|Repository|Interface)\w*)\s+/,                    kind: 'dependency' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, kind } of patterns) {
      const m = line.match(re);
      if (!m) continue;
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

const INCLUDE_GLOBS  = ['**/*.ts', '**/*.cs', '**/*.html'];
const EXCLUDE_GLOBS  = '**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/bin/**,**/obj/**';
const MAX_FILE_SIZE  = 200 * 1024; // 200KB — skip huge generated files

export async function buildIndex(workspaceRoot: string): Promise<WorkspaceIndex> {
  const index: WorkspaceIndex = { builtAt: new Date().toISOString(), symbols: [] };

  for (const glob of INCLUDE_GLOBS) {
    const uris = await vscode.workspace.findFiles(glob, `{${EXCLUDE_GLOBS}}`);

    for (const uri of uris) {
      try {
        const stat = fs.statSync(uri.fsPath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const content  = fs.readFileSync(uri.fsPath, 'utf8');
        const relPath  = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
        const ext      = path.extname(uri.fsPath).toLowerCase();

        let symbols: SymbolEntry[] = [];
        if (ext === '.ts')         symbols = extractTsSymbols(content, relPath);
        else if (ext === '.cs')    symbols = extractCsSymbols(content, relPath);
        // .html skipped for now — rarely needed for symbol lookup

        index.symbols.push(...symbols);
      } catch { /* skip unreadable files */ }
    }
  }

  return index;
}

export function saveIndex(index: WorkspaceIndex, workspaceRoot: string): void {
  const filePath = path.join(workspaceRoot, INDEX_FILENAME);
  try {
    fs.writeFileSync(filePath, JSON.stringify(index, null, 2), 'utf8');
  } catch (e) {
    console.error('[PM Indexer] Failed to save index:', e);
  }
}

export function loadIndex(workspaceRoot: string): WorkspaceIndex | null {
  const filePath = path.join(workspaceRoot, INDEX_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as WorkspaceIndex;
  } catch {
    return null;
  }
}

/**
 * Find symbols relevant to the given code snippet.
 * Simple strategy: look for identifiers in the code that match symbol names in the index.
 */
export function findRelevantSymbols(code: string, index: WorkspaceIndex, maxResults = 8): SymbolEntry[] {
  // Extract candidate identifiers from the code (PascalCase and camelCase words, length > 3)
  const identifiers = new Set(
    (code.match(/\b[A-Za-z][a-zA-Z0-9]{3,}\b/g) ?? [])
      .filter(w => /[A-Z]/.test(w)) // at least one uppercase — likely a type/class name
  );

  if (identifiers.size === 0) return [];

  const scored: { entry: SymbolEntry; score: number }[] = [];

  for (const entry of index.symbols) {
    if (identifiers.has(entry.name)) {
      // Higher score for interfaces and classes (more useful as context)
      const kindScore = ['interface', 'class', 'record', 'service', 'component'].includes(entry.kind) ? 2 : 1;
      scored.push({ entry, score: kindScore });
    }
  }

  // Sort by score desc, deduplicate by name
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ entry }) => {
      if (seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .slice(0, maxResults)
    .map(({ entry }) => entry);
}

/**
 * Format relevant symbols as a context block for the LLM prompt.
 */
export function formatSymbolsBlock(symbols: SymbolEntry[]): string {
  if (symbols.length === 0) return '';
  const lines = symbols.map(s => `- ${s.kind} \`${s.name}\` in ${s.file}:${s.line} — ${s.preview}`);
  return `\nProject symbols referenced in this code:\n${lines.join('\n')}`;
}

/**
 * Search symbols by name, for Chat Participant user queries (natural-language search).
 * Unlike findRelevantSymbols: case-insensitive substring match, no PascalCase requirement.
 */
export function searchSymbolsByName(
  query: string,
  index: WorkspaceIndex,
  maxResults = 10,
): SymbolEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored = index.symbols
    .filter(s => s.name.toLowerCase().includes(q))
    .map(entry => {
      const exact = entry.name.toLowerCase() === q;
      const kindScore = ['interface', 'class', 'record', 'service', 'component'].includes(entry.kind) ? 2 : 1;
      return { entry, score: (exact ? 10 : 0) + kindScore };
    });

  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ entry }) => {
      const key = `${entry.name}:${entry.file}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults)
    .map(({ entry }) => entry);
}
