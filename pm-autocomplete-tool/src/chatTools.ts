import * as path from "path";
import * as vscode from "vscode";
import { ToolSpec } from "./api";
import { formatSymbolsBlock, loadIndex, searchSymbolsByName } from "./indexer";

// ──────────────────────────────────────────────
// Costanti condivise con indexer.ts (stessi criteri di esclusione, tenute qui
// duplicate per evitare accoppiamento — se cambi EXCLUDE_GLOBS in indexer.ts,
// aggiorna anche qui).
// ──────────────────────────────────────────────
const EXCLUDE_GLOBS =
  "**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/bin/**,**/obj/**";
const MAX_FILE_SIZE = 200 * 1024; // 200KB, come in indexer.ts
const MAX_READ_CHARS = 8000; // stesso cap di getCurrentFileContent
const MAX_SEARCH_RESULTS = 40;
const MAX_GREP_FILES_SCANNED = 500; // limite duro per non bloccare su workspace enormi
const MAX_GREP_MATCHES = 30;

// ──────────────────────────────────────────────
// Utility functions esistenti
// ──────────────────────────────────────────────

/** Legge il contenuto del file attivo nell'editor. */
export function getCurrentFileContent(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return "⚠️ Nessun file aperto nell'editor.";
  }

  const doc = editor.document;
  const text = doc.getText();
  let truncated = text;
  if (text.length > MAX_READ_CHARS) {
    truncated = text.slice(0, MAX_READ_CHARS) + "\n... [truncated]";
  }

  return `File attivo: ${doc.fileName}\nLinguaggio: ${doc.languageId}\n\n${truncated}`;
}

/** Cerca simboli nell'indice workspace e restituisce il blocco formattato. */
export function searchWorkspaceSymbols(query: string): string {
  if (!query.trim()) {
    return "⚠️ Fornisci un termine di ricerca per la query.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  const idx = loadIndex(folders[0].uri.fsPath);
  if (!idx) {
    return "⚠️ Indice workspace non disponibile. Esegui /pmAutocomplete.reindex.";
  }

  const relevant = searchSymbolsByName(query, idx, 10);
  const formatted = formatSymbolsBlock(relevant);

  return formatted || "Nessun simbolo trovato.";
}

/** Verifica se i tool VS Code nativi sono disponibili (VS Code 1.97+, Copilot Chat). */
export function isToolsApiAvailable(): boolean {
  try {
    return typeof (vscode.lm as any).registerTool === "function";
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// Sicurezza path — stessa policy di edits.ts (isSafeRelativePath):
// rifiuta path assoluti o con traversal, il modello deve restare nel workspace.
// Duplicata qui perché edits.ts non la esporta; se la esponi, sostituisci con import.
// ──────────────────────────────────────────────
function isSafeRelativePath(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p).replace(/\\/g, "/");
  return !normalized.startsWith("..") && !normalized.includes("/../");
}

// ──────────────────────────────────────────────
// Nuovi tool — esplorazione file arbitrari (stile Copilot: search → read → grep)
// ──────────────────────────────────────────────

/** Cerca file per glob pattern, ritorna solo i path (non il contenuto). */
async function searchFiles(glob: string): Promise<string> {
  if (!glob.trim()) {
    return "⚠️ Fornisci un pattern glob, es. **/*Controller.cs";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  try {
    const uris = await vscode.workspace.findFiles(
      glob,
      `{${EXCLUDE_GLOBS}}`,
      MAX_SEARCH_RESULTS,
    );
    if (uris.length === 0) {
      return `Nessun file trovato per il pattern "${glob}".`;
    }
    const root = folders[0].uri.fsPath;
    const relPaths = uris.map((u) =>
      path.relative(root, u.fsPath).replace(/\\/g, "/"),
    );
    const suffix =
      uris.length === MAX_SEARCH_RESULTS
        ? `\n... (limite di ${MAX_SEARCH_RESULTS} risultati raggiunto, affina il pattern)`
        : "";
    return `File trovati (${relPaths.length}):\n${relPaths.map((p) => `- ${p}`).join("\n")}${suffix}`;
  } catch (e) {
    return `⚠️ Errore nella ricerca file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Legge un file arbitrario del workspace dato il path relativo (non richiede che sia
 * aperto nell'editor). Supporta paging per riga (start_line/end_line, 1-indexed,
 * end_line incluso) — indispensabile per file lunghi: senza paging, una richiesta
 * di "leggi il resto" otterrebbe sempre lo stesso blocco troncato, causando un loop
 * di tool call identici (bug osservato: il modello rilancia read-file pensando di
 * ottenere altro, finisce per sbattere contro MAX_TOOL_ROUNDS).
 * La risposta include sempre il conteggio totale righe, così il modello sa
 * pianificare la chiamata successiva invece di ritentare a caso.
 */
async function readFile(
  relPath: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  if (!relPath.trim()) {
    return "⚠️ Fornisci il percorso relativo del file da leggere.";
  }
  if (!isSafeRelativePath(relPath)) {
    return "⚠️ Percorso non valido: usa un path relativo al workspace, senza .. o path assoluti.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  try {
    const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const allLines = Buffer.from(bytes).toString("utf8").split("\n");
    const totalLines = allLines.length;

    // Nessun range richiesto: comportamento precedente (primi MAX_READ_CHARS char),
    // ma ora annunciamo esplicitamente se il file continua oltre, con il range da
    // richiedere per il pezzo successivo.
    if (startLine === undefined && endLine === undefined) {
      const full = allLines.join("\n");
      if (full.length <= MAX_READ_CHARS) {
        return `File: ${relPath} (${totalLines} righe totali)\n\n${full}`;
      }
      // Stima quante righe stanno nel cap di caratteri, per suggerire un range utile
      const approxLinesFit = Math.max(
        1,
        Math.floor((MAX_READ_CHARS / full.length) * totalLines),
      );
      const truncated = allLines.slice(0, approxLinesFit).join("\n");
      return `File: ${relPath} — TRONCATO. Il file ha ${totalLines} righe totali, qui sotto le righe 1-${approxLinesFit}.\nPer continuare, richiama read-file con start_line=${approxLinesFit + 1} (e opzionalmente end_line) per leggere il resto.\n\n${truncated}`;
    }

    // Range esplicito: 1-indexed, clampato ai limiti del file.
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, endLine ?? totalLines);
    if (start > totalLines) {
      return `⚠️ start_line=${start} oltre la fine del file (${totalLines} righe totali).`;
    }
    const slice = allLines.slice(start - 1, end).join("\n");
    const hasMore = end < totalLines;
    const suffix = hasMore
      ? `\n\n[Righe ${start}-${end} di ${totalLines} totali. Per continuare: start_line=${end + 1}]`
      : `\n\n[Righe ${start}-${end} di ${totalLines} totali — fine file raggiunta]`;
    return `File: ${relPath}${suffix}\n\n${slice}`;
  } catch {
    return `⚠️ File non trovato o non leggibile: ${relPath}`;
  }
}

/** Ricerca testuale (grep) su file del workspace, con numero di riga per ogni match. */
async function grepText(query: string, glob?: string): Promise<string> {
  if (!query.trim()) {
    return "⚠️ Fornisci un termine da cercare.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  const root = folders[0].uri.fsPath;
  const includeGlob = glob?.trim() || "**/*.{ts,tsx,cs,html,json,md}";

  try {
    const uris = await vscode.workspace.findFiles(
      includeGlob,
      `{${EXCLUDE_GLOBS}}`,
      MAX_GREP_FILES_SCANNED,
    );

    const needle = query.toLowerCase();
    const matches: string[] = [];

    for (const uri of uris) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_SIZE) continue;

        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const lines = text.split("\n");
        const relPath = path.relative(root, uri.fsPath).replace(/\\/g, "/");

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push(
              `${relPath}:${i + 1}: ${lines[i].trim().slice(0, 150)}`,
            );
            if (matches.length >= MAX_GREP_MATCHES) break;
          }
        }
      } catch {
        continue; // file non leggibile — skip
      }
    }

    if (matches.length === 0) {
      return `Nessun risultato per "${query}"${glob ? ` (pattern: ${glob})` : ""}.`;
    }
    const suffix =
      matches.length >= MAX_GREP_MATCHES
        ? `\n... (limite di ${MAX_GREP_MATCHES} match raggiunto, affina la query)`
        : "";
    return `Risultati per "${query}" (${matches.length}):\n${matches.join("\n")}${suffix}`;
  } catch (e) {
    return `⚠️ Errore nella ricerca testuale: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Applica una modifica a un file del workspace sostituendo un frammento di testo
 * ESATTO (old_string → new_string). È il tool con cui il modello applica le
 * correzioni da solo, invece di riscrivere l'intero file in chat (fragile: con
 * file lunghi sfora il budget di token e il fence resta troncato/inapplicabile).
 *
 * Contratto:
 * - old_string vuota → crea un nuovo file con new_string come contenuto
 *   (errore se il file esiste già, per non sovrascrivere per sbaglio).
 * - old_string deve comparire UNA volta sola, salvo replace_all=true — se compare
 *   più volte l'errore chiede al modello di aggiungere contesto, non indoviniamo.
 * - Legge il contenuto via openTextDocument (non fs) per vedere anche le modifiche
 *   non salvate di editor aperti; applica via WorkspaceEdit (un solo undo, editor
 *   aggiornati) e poi salva, così le read-file successive da disco sono coerenti.
 */
async function editFile(
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<string> {
  if (!relPath.trim()) {
    return "⚠️ Fornisci il percorso relativo del file da modificare.";
  }
  if (!isSafeRelativePath(relPath)) {
    return "⚠️ Percorso non valido: usa un path relativo al workspace, senza .. o path assoluti.";
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "⚠️ Nessun workspace aperto.";
  }

  const uri = vscode.Uri.joinPath(folders[0].uri, relPath);

  // old_string vuota → creazione nuovo file
  if (oldString === "") {
    try {
      await vscode.workspace.fs.stat(uri);
      return `⚠️ Il file ${relPath} esiste già. Per modificarlo, passa in old_string il testo esatto da sostituire.`;
    } catch {
      // il file non esiste: ok, lo creiamo
    }
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(newString, "utf8"));
      return `✅ File creato: ${relPath} (${newString.split("\n").length} righe).`;
    } catch (e) {
      return `⚠️ Impossibile creare il file ${relPath}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return `⚠️ File non trovato o non leggibile: ${relPath}. Usa search-files per trovare il path corretto, o old_string vuota per creare un file nuovo.`;
  }

  const text = doc.getText();
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) {
    return `⚠️ Testo non trovato in ${relPath}. old_string deve corrispondere ESATTAMENTE al contenuto del file, spazi e indentazione inclusi. Rileggi il file con read-file e riprova copiando il testo esatto.`;
  }
  if (occurrences > 1 && !replaceAll) {
    return `⚠️ old_string compare ${occurrences} volte in ${relPath}. Aggiungi righe di contesto prima/dopo per renderla univoca, oppure usa replace_all=true per sostituirle tutte.`;
  }

  const newText = replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, newString);

  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return `⚠️ VS Code ha rifiutato la modifica a ${relPath}.`;
  }
  await doc.save();

  const count = replaceAll ? occurrences : 1;
  return `✅ Modifica applicata e salvata in ${relPath} (${count} sostituzion${count === 1 ? "e" : "i"}).`;
}

// ──────────────────────────────────────────────
// Tool calling nativo per il chat participant @pm (via streamChat + llama-server)
// ──────────────────────────────────────────────

/** Schema JSON dei tool, inoltrato a llama-server nel campo `tools` della request. */
export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "current-file",
      description: "Reads the content of the currently active editor file.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace-symbols",
      description:
        "Searches the workspace index for symbols (components, services, classes, methods) by name, case-insensitive substring match.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term to match against symbol names.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search-files",
      description:
        "Finds files in the workspace by glob pattern (e.g. '**/*Controller.cs', '**/QuoteDto.cs'). Returns file paths only, not content. Use this before read-file when you don't know the exact path.",
      parameters: {
        type: "object",
        properties: {
          glob: {
            type: "string",
            description: "Glob pattern relative to workspace root.",
          },
        },
        required: ["glob"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read-file",
      description:
        "Reads a file in the workspace by its relative path, even if it's not open in the editor. For large files, the result may be truncated with the total line count and a suggested next range — call read-file again with start_line/end_line to read the rest, do NOT call it again with the same arguments expecting different output. Use search-files or workspace-symbols first if you don't know the exact path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to the workspace root.",
          },
          start_line: {
            type: "integer",
            description:
              "1-indexed first line to read (optional, omit to read from the start).",
          },
          end_line: {
            type: "integer",
            description:
              "1-indexed last line to read, inclusive (optional, omit to read to the end or to the truncation cap).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep-text",
      description:
        "Searches for a text string across files in the workspace and returns matching lines with file path and line number. Use this to find code that isn't a named symbol (e.g. a string literal, a route, a config value).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for (case-insensitive).",
          },
          glob: {
            type: "string",
            description:
              "Optional glob to restrict the search (default: common source file extensions).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit-file",
      description:
        "APPLIES a change to a workspace file by replacing an exact text fragment. This is how you apply code fixes — do NOT paste the modified file into the chat. Workflow: read the file first (read-file/current-file), then call edit-file once per change. old_string must match the file content EXACTLY (whitespace and indentation included) and must be unique in the file — include enough surrounding lines to make it unique. Pass an empty old_string to create a new file with new_string as its content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to the workspace root.",
          },
          old_string: {
            type: "string",
            description:
              "Exact text to replace, copied verbatim from the file. Empty string to create a new file.",
          },
          new_string: {
            type: "string",
            description:
              "Replacement text (empty to delete old_string). For a new file, the full file content.",
          },
          replace_all: {
            type: "boolean",
            description:
              "Replace every occurrence of old_string instead of requiring it to be unique (default false).",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage-todo-list",
      description:
        "Creates or updates a visible step-by-step plan for a multi-step task (e.g. a refactor spanning several files). Call with action='create' once at the start of a non-trivial task to list the steps, then action='update' to mark items in-progress/completed as you work. Skip this entirely for simple one-shot answers.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update"],
            description:
              "'create' replaces the whole list; 'update' merges status/text changes into existing items by id.",
          },
          items: {
            type: "array",
            description:
              "For 'create': the full ordered list of steps. For 'update': only the items whose id/status/text changed.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable short id (e.g. '1', '2'). Required for 'update'; auto-assigned by position if omitted on 'create'.",
                },
                text: {
                  type: "string",
                  description: "Short description of the step.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in-progress", "completed"],
                },
              },
            },
          },
        },
        required: ["action", "items"],
      },
    },
  },
];

/** Nomi dei tool che leggono contenuto file — usati dal caller per applicare un cap separato su quante letture concedere per conversazione. */
export const FILE_READ_TOOLS = new Set(["current-file", "read-file"]);

/**
 * Tool read-only e deterministici a parità di stato del workspace: una chiamata
 * ripetuta con argomenti identici nello stesso turno restituirebbe lo stesso
 * risultato. Il caller li usa per rilevare loop (modello che rilancia la stessa
 * chiamata sperando in un output diverso) e rispondere con un avviso invece di
 * bruciare round. edit-file e manage-todo-list sono esclusi di proposito:
 * mutano stato, ripeterli ha semantica diversa.
 */
export const READ_ONLY_TOOLS = new Set([
  "current-file",
  "read-file",
  "search-files",
  "grep-text",
  "workspace-symbols",
]);

// ──────────────────────────────────────────────
// Todo list — stato e rendering. Gestita a parte da executeTool (non nello
// switch sotto) perché "manage-todo-list" ha due esigenze che gli altri tool
// non hanno: (1) stato che persiste tra i round di uno stesso turno, e (2) un
// effetto visibile in chat (checklist renderizzata via stream.markdown), non
// solo un risultato testuale da rimandare al modello. chatRequestHandler.ts
// intercetta questo tool per nome prima di chiamare executeTool.
// ──────────────────────────────────────────────

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in-progress" | "completed";
}

/**
 * Calcola il nuovo stato della todo list data un'azione — funzione pura, nessun
 * side effect, testabile in isolamento. 'create' sostituisce l'intera lista
 * (assegna id per posizione se mancante); 'update' fa merge per id, ignorando
 * id sconosciuti (li segnala nel messaggio di ritorno di chi la chiama).
 */
export function applyTodoAction(
  current: TodoItem[],
  action: "create" | "update",
  items: Partial<TodoItem>[],
): { next: TodoItem[]; unknownIds: string[] } {
  if (action === "create") {
    const next = items.map((it, i) => ({
      id: it.id ?? String(i + 1),
      text: it.text ?? "(senza descrizione)",
      status: it.status ?? "pending",
    }));
    return { next, unknownIds: [] };
  }

  // action === "update"
  const byId = new Map(current.map((t) => [t.id, { ...t }]));
  const unknownIds: string[] = [];
  for (const it of items) {
    if (!it.id) continue;
    const existing = byId.get(it.id);
    if (!existing) {
      unknownIds.push(it.id);
      continue;
    }
    if (it.text !== undefined) existing.text = it.text;
    if (it.status !== undefined) existing.status = it.status;
  }
  return { next: Array.from(byId.values()), unknownIds };
}

/** Rende la todo list come checklist markdown, per essere mostrata in chat via stream.markdown. */
export function formatTodoMarkdown(items: TodoItem[]): string {
  if (items.length === 0) return "";
  const icon = (s: TodoItem["status"]) =>
    s === "completed" ? "✅" : s === "in-progress" ? "🔄" : "⬜";
  const lines = items.map((it) => `${icon(it.status)} ${it.text}`);
  return `\n**Piano:**\n${lines.join("\n")}\n`;
}

/**
 * Esegue un tool per nome, dato l'argomento JSON grezzo ricevuto da un tool_call.
 * Async: read-file/search-files/grep-text fanno I/O su disco/workspace.
 * Non lancia mai — ritorna sempre una stringa (errore incluso) da rimandare al
 * modello come risultato del tool.
 * NB: "manage-todo-list" NON passa da qui — è intercettato prima in
 * chatRequestHandler.ts (vedi commento sopra).
 */
export async function executeTool(
  name: string,
  rawArguments: string,
): Promise<string> {
  try {
    switch (name) {
      case "current-file":
        return getCurrentFileContent();

      case "workspace-symbols": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return searchWorkspaceSymbols(
          typeof args.query === "string" ? args.query : "",
        );
      }

      case "search-files": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return await searchFiles(
          typeof args.glob === "string" ? args.glob : "",
        );
      }

      case "read-file": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        const startLine =
          typeof args.start_line === "number" ? args.start_line : undefined;
        const endLine =
          typeof args.end_line === "number" ? args.end_line : undefined;
        return await readFile(
          typeof args.path === "string" ? args.path : "",
          startLine,
          endLine,
        );
      }

      case "grep-text": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return await grepText(
          typeof args.query === "string" ? args.query : "",
          typeof args.glob === "string" ? args.glob : undefined,
        );
      }

      case "edit-file": {
        const args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
        return await editFile(
          typeof args.path === "string" ? args.path : "",
          typeof args.old_string === "string" ? args.old_string : "",
          typeof args.new_string === "string" ? args.new_string : "",
          args.replace_all === true,
        );
      }

      default:
        return `⚠️ Tool sconosciuto: ${name}`;
    }
  } catch (e) {
    console.error(`[PM Chat] Errore eseguendo tool ${name}:`, e);
    return `⚠️ Errore nell'esecuzione del tool ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ──────────────────────────────────────────────
// Registrazione tool nativi VS Code (vscode.lm.registerTool) — meccanismo separato,
// usato quando l'utente interagisce con questi tool da Copilot Chat / agent mode,
// non dal nostro chat participant @pm (che usa TOOL_SPECS + executeTool sopra).
// Richiede VS Code 1.97+. NB: qui registriamo solo i due tool storici; se vuoi
// esporre anche search-files/read-file/grep-text a Copilot nativo, aggiungi
// classi analoghe a CurrentFileTool/WorkspaceSymbolsTool sotto.
// ──────────────────────────────────────────────

export function registerChatTools(context: vscode.ExtensionContext): void {
  if (!isToolsApiAvailable()) {
    console.log(
      "[PM Chat] Tools API nativa non disponibile — versione VS Code troppo vecchia per vscode.lm.registerTool",
    );
    return;
  }

  const currentFileTool = new CurrentFileTool();
  const workspaceSymbolsTool = new WorkspaceSymbolsTool();

  context.subscriptions.push(
    vscode.lm.registerTool(currentFileTool.name, currentFileTool),
    vscode.lm.registerTool(workspaceSymbolsTool.name, workspaceSymbolsTool),
  );
}

class CurrentFileTool implements vscode.LanguageModelTool<CurrentFileInput> {
  name = "current-file";
  description = "Reads the content of the currently active editor file.";

  inputSchema = { type: "object", properties: {} } as object;

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<CurrentFileInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
    const content = getCurrentFileContent();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(content),
    ]);
  }
}

class WorkspaceSymbolsTool implements vscode.LanguageModelTool<WorkspaceSymbolsInput> {
  name = "workspace-symbols";
  description = "Searches the workspace index for relevant symbols.";

  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search term to find in symbol names.",
      },
    },
  } as object;

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<WorkspaceSymbolsInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
    const query = options.input?.query ?? "";
    const result = searchWorkspaceSymbols(query);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result),
    ]);
  }
}

interface CurrentFileInput {}

interface WorkspaceSymbolsInput {
  query: string;
}
