export function stripThinkTags(text: string): string {
  const closeIdx = text.indexOf('</think>');
  if (closeIdx !== -1) return text.slice(closeIdx + '</think>'.length).trimStart();
  if (text.includes('<think>')) return '';

  const gemmaClose = text.indexOf('<channel|>');
  if (gemmaClose !== -1) return text.slice(gemmaClose + '<channel|>'.length).trimStart();
  if (text.includes('<|channel>')) return '';

  return text;
}

export function extractCode(text: string): string {
  text = stripThinkTags(text);

  const fenceMatch = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const DISCARD_PREFIXES = [
    'here is', "here's", 'sure', 'corrected code:', 'fixed code:',
    'i have', "i've", 'below is', 'the following', 'as requested',
    'certainly', 'of course', 'please find', 'here is the',
    'please provide', 'please share', 'please paste', 'please include',
    'could you', 'can you', 'i need', 'i would need',
  ];

  const CODE_CHARS = /[=;{}()\[\]<>+\-*\/\\|&^%$#@!~`]/;
  const isNaturalLanguage = (line: string) => {
    const t = line.trim();
    return t.length > 0 && !CODE_CHARS.test(t) && /[a-zA-Z]/.test(t) && t.length < 120;
  };

  const lines = text.split('\n');
  const codeLines: string[] = [];
  let foundCodeStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    const isIntro = DISCARD_PREFIXES.some(p => lowerTrimmed.startsWith(p))
                 || (isNaturalLanguage(line) && !foundCodeStarted)
                 || (foundCodeStarted && isNaturalLanguage(line) && DISCARD_PREFIXES.some(p => lowerTrimmed.includes(p)));

    if (!isIntro && trimmed.length > 0) {
      codeLines.push(line);
      foundCodeStarted = true;
    } else if (foundCodeStarted && trimmed === '') {
      codeLines.push(line);
    }
  }

  const result = codeLines.join('\n').trim();
  return result.length > 0 ? result : text.trim();
}

export function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}