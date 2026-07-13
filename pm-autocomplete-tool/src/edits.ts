import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Una modifica proposta dalla chat, serializzabile (viene passata come
 * argomento del bottone "Applica modifiche" nel Chat Participant).
 * - `range` assente → sostituzione dell'intero file (creato se non esiste)
 * - `range` presente → sostituzione della sola selezione (usato da /fix, /edit)
 */
export interface ProposedEdit {
  filePath: string; // relativo alla root del workspace, oppure assoluto (solo per edit su selezione)
  content: string;
  range?: { startLine: number; startChar: number; endLine: number; endChar: number };
}

/**
 * Estrae dalla risposta del modello i code block con marker di file
 * (convenzione: ```linguaggio:percorso/relativo.ext — vedi EDIT_FORMAT_INSTRUCTION).
 * I blocchi senza `:percorso` nell'info string vengono ignorati.
 * Se lo stesso file compare più volte, vince l'ultimo blocco.
 */
export function parseFileEdits(text: string): ProposedEdit[] {
  const byPath = new Map<string, ProposedEdit>();
  const re = /```[a-zA-Z0-9#+.-]*:([^\n`]+)\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1].trim().replace(/\\/g, '/');
    const content = m[2].replace(/\r?\n$/, '');
    if (!filePath || !isSafeRelativePath(filePath)) continue;
    byPath.set(filePath, { filePath, content });
  }
  return [...byPath.values()];
}

/** Rifiuta path assoluti o con traversal (..) — il modello deve restare dentro il workspace. */
function isSafeRelativePath(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p).replace(/\\/g, '/');
  return !normalized.startsWith('..') && !normalized.includes('/../');
}

function toUri(edit: ProposedEdit, root: vscode.Uri): vscode.Uri {
  return path.isAbsolute(edit.filePath)
    ? vscode.Uri.file(edit.filePath)
    : vscode.Uri.joinPath(root, edit.filePath);
}

/**
 * Applica le modifiche proposte con un unico vscode.WorkspaceEdit
 * (quindi un solo undo, e supporto multi-file nativo).
 */
export async function applyProposedEdits(edits: ProposedEdit[]): Promise<boolean> {
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
      wsEdit.replace(
        uri,
        new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar),
        edit.content,
      );
      continue;
    }

    // Sostituzione intero file: se esiste rimpiazza tutto, altrimenti crealo
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      wsEdit.replace(uri, fullRange, edit.content);
    } catch {
      wsEdit.createFile(uri, { ignoreIfExists: true });
      wsEdit.insert(uri, new vscode.Position(0, 0), edit.content);
    }
  }

  return vscode.workspace.applyEdit(wsEdit);
}
