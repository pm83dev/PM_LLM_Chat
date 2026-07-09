import * as vscode from 'vscode';
import { stripThinkTags } from './utils';
import { REQUEST_TIMEOUT_MS, STOP_SEQUENCES } from './config';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export let activeController: AbortController | undefined;

export function abortActiveRequests() {
  activeController?.abort();
}

export async function callServer(
  prompt: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  stopSequences: string[],
  signal: AbortSignal,
  serverUrl: string
): Promise<string | null> {
  const endpoint = `${serverUrl}/completion`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt, max_tokens: maxTokens, temperature,
        stop: stopSequences, stream: false, cache_prompt: true,
        top_k: 40, top_p: 0.95, min_p: 0.05, repeat_penalty: 1.1,
      }),
      signal,
    });

    if (!response.ok) { console.error(`[PM] Server error: ${response.status}`); return null; }

    const data = await response.json() as { content?: string };
    return data.content != null ? stripThinkTags(data.content) : null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return null;
    console.error('[PM] Fetch error:', err);
    return null;
  }
}

export async function fetchCompletion(
  prompt: string,
  cancelToken: vscode.CancellationToken,
  serverUrl: string,
  maxTokens: number,
  temperature: number
): Promise<string | null> {
  activeController?.abort();
  activeController = new AbortController();
  const timeoutId     = setTimeout(() => activeController?.abort(), REQUEST_TIMEOUT_MS);
  const cancelDispose = cancelToken.onCancellationRequested(() => activeController?.abort());
  try {
    return await callServer(prompt, maxTokens, temperature, REQUEST_TIMEOUT_MS, STOP_SEQUENCES, activeController.signal, serverUrl);
  } finally {
    clearTimeout(timeoutId);
    cancelDispose.dispose();
  }
}

export function buildActionPrompt(system: string, user: string, family: string): string {
  switch (family) {
    case 'gemma': return `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n`;
    case 'llama': return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n${system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n${user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n`;
    case 'qwen':
    default:      return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
  }
}

export function actionStopSequences(family: string): string[] {
  switch (family) {
    case 'gemma': return ['<end_of_turn>', '<start_of_turn>', '<eos>'];
    case 'llama': return ['<|eot_id|>', '<|start_header_id|>', '<eos>'];
    case 'qwen':
    default:      return ['<|im_end|>', '<|im_start|>', '<eos>'];
  }
}

export async function fetchAction(
  systemPrompt: string,
  userContent: string,
  actionServerUrl: string,
  fallbackUrl: string,
  family: string,
  actionMaxTokens: number,
  actionTimeoutMs: number   // ← da settings, non più costante hardcoded
): Promise<string | null> {
  activeController?.abort();
  activeController = new AbortController();
  const timeoutId = setTimeout(() => activeController?.abort(), actionTimeoutMs);
  const url    = actionServerUrl.trim() || fallbackUrl;
  const prompt = buildActionPrompt(systemPrompt, userContent, family);
  try {
    return await callServer(prompt, actionMaxTokens, 0.2, actionTimeoutMs, actionStopSequences(family), activeController.signal, url);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function streamChat(
  messages: ChatMessage[],
  chatEndpoint: string,
  chatModel: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (msg: string) => void
): Promise<void> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 120000); // 2 min per chat

  try {
    const response = await fetch(chatEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: ctrl.signal,
    });

    if (!response.ok) { onError(`Server error: ${response.status}`); return; }
    if (!response.body) { onError('No response body'); return; }

    const reader    = response.body.getReader();
    const decoder   = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { onDone(); return; }

        try {
          const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            accumulated += content;
            const clean = stripThinkTags(accumulated);
            if (clean) onChunk(clean);
          }
        } catch { /* skip partial JSON */ }
      }
    }
    onDone();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      onError('Request timed out');
    } else {
      const msg = err instanceof Error ? `${err.message} — endpoint: ${chatEndpoint}` : String(err);
      onError(msg);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
