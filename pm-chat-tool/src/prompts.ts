// Prompt condivisi tra i comandi editor (Ctrl+. / Ctrl+Shift+.) e gli slash
// command chat (/fix, /edit) — un'unica fonte per evitare divergenze.

export function getStackGuidance(lang: string, filename: string): string {
  if (
    lang === "typescript" ||
    lang === "html" ||
    filename.endsWith(".component.ts")
  ) {
    return "Tech stack: Angular 18+. Always use Standalone Components, Signals (no NgRx/NGXS), and the new Control Flow syntax (@if, @for, @switch) instead of *ngIf/*ngFor.";
  }
  if (lang === "csharp") {
    return "Tech stack: .NET 8/9. Prefer Minimal APIs or Worker Services. Respect existing Dependency Injection patterns and interface contracts already used in the file.";
  }
  return "";
}

export function buildFixSystemPrompt(lang: string, filename: string): string {
  return [
    `You are a code transformation engine. Language: ${lang}. File: ${filename}.`,
    getStackGuidance(lang, filename),
    `TASK: Fix bugs and syntax errors in the provided code.`,
    `OUTPUT RULE: Return ONLY the corrected code, nothing else.`,
    `STRICT PROHIBITIONS:`,
    `- NO markdown fences (no \`\`\`).`,
    `- NO introductory text (no "Here is", "Sure", etc.).`,
    `- NO concluding remarks. - NO explanations. - NO requests for clarification.`,
    `Example: User: Fix this: int x = "hello"; Assistant: string x = "hello";`,
    `If you understand, output only the code.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildEditSystemPrompt(lang: string, filename: string): string {
  return [
    `You are a code transformation engine. Language: ${lang}. File: ${filename}.`,
    getStackGuidance(lang, filename),
    `TASK: Rewrite the code following the user instruction exactly.`,
    `OUTPUT RULE: Return ONLY the rewritten code, nothing else.`,
    `STRICT PROHIBITIONS:`,
    `- NO markdown fences (no \`\`\`). - NO introductory text. - NO concluding remarks.`,
    `- NO explanations. - NO requests for clarification.`,
    `Example: User: Add null check | Code: return user.Name; Assistant: if (user == null) return null;\nreturn user.Name;`,
    `If you understand, output only the code.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Istruzione aggiunta al system prompt della chat: quando il modello propone
 * modifiche a file del progetto deve usare il marker `linguaggio:percorso`
 * nell'info string del code block, così edits.ts può fare il parsing e
 * proporre l'apply via WorkspaceEdit (Fase 4 della spec).
 */
export const EDIT_FORMAT_INSTRUCTION = [
  'When you propose changes to project files, output each modified file as ONE fenced code block',
  'whose info string is "<language>:<relative/path/from/workspace/root>",',
  'for example: ```typescript:src/app/foo.component.ts',
  'The block must contain the COMPLETE new content of that file, not a fragment.',
  'Use this format only for actual file modifications; for illustrative snippets use plain code blocks without a path.',
].join(' ');
