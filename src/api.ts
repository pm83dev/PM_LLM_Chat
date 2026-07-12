import * as vscode from 'vscode';
import { stripThinkTags } from './utils';
import { REQUEST_TIMEOUT_MS, STOP_SEQUENCES } from './config';

// ──────────────────────────────────────────────
// Chat message types (OpenAI-compatible, con supporto tool calling)
// ──────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];   // presente solo su messaggi assistant che hanno chiamato un tool
  tool_call_id?: string;     // presente solo su messaggi role: 'tool' (risultato)
  name?: string;             // nome del tool, usato insieme a tool_call_id
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolCall {
  index?: number;
  id?: string;
  type?: 'function';
  function: { name?: string; arguments: string }; // arguments è una stringa JSON
}

export let activeController: AbortController | undefined;

export function abortActiveRequests() {
  activeController?.abort();
}

// ──────────────────────────────────────────────
// /completion — usata da fetchCompletion (FIM) e fetchAction (/fix, /edit)
// Invariata: questi flussi non passano da chat template con ruoli, restano
// completion pura con prompt costruito a mano per famiglia di modello.
// ──────────────────────────────────────────────

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
  actionTimeoutMs: number
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

// ──────────────────────────────────────────────
// /v1/chat/completions — usata dal Chat Participant, con tool calling nativo
// ──────────────────────────────────────────────

/**
 * streamChat con supporto tool_calls (OpenAI-compatible, confermato funzionante
 * su llama-server con Qwen3.6-35B-A3B via chat template Hermes/ChatML).
 *
 * Se il caller passa `tools`, li inoltra nel body come `tools` + `tool_choice: "auto"`.
 * Se lo stream termina con finish_reason: "tool_calls", i tool_calls accumulati
 * (gli argomenti arrivano frammentati su più delta, per index) vengono passati a
 * onToolCalls invece di essere trattati come testo — niente più parsing regex
 * sul contenuto grezzo.
 */
export async function streamChat(
  messages: ChatMessage[],
  chatEndpoint: string,
  chatModel: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
  tools?: ToolSpec[],
  onToolCalls?: (calls: ToolCall[]) => void
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
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: ctrl.signal,
    });

    if (!response.ok) { onError(`Server error: ${response.status}`); return; }
    if (!response.body) { onError('No response body'); return; }

    const reader    = response.body.getReader();
    const decoder   = new TextDecoder();
    let accumulated = '';
    const toolCallsAcc = new Map<number, ToolCall>();
    let finishReason: string | null = null;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;

        try {
          const parsed = JSON.parse(data) as {
            choices?: {
              delta?: { content?: string; tool_calls?: ToolCall[] };
              finish_reason?: string | null;
            }[];
          };
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const content = choice.delta?.content;
          if (content) {
            accumulated += content;
            const clean = stripThinkTags(accumulated);
            if (clean) onChunk(clean);
          }

          const deltaCalls = choice.delta?.tool_calls;
          if (deltaCalls) {
            for (const dc of deltaCalls) {
              const idx = dc.index ?? 0;
              const existing = toolCallsAcc.get(idx);
              if (!existing) {
                toolCallsAcc.set(idx, {
                  index: idx,
                  id: dc.id,
                  type: 'function',
                  function: {
                    name: dc.function?.name,
                    arguments: dc.function?.arguments ?? '',
                  },
                });
              } else {
                // arguments arriva a pezzi — va concatenato, mai sovrascritto
                existing.function.arguments += dc.function?.arguments ?? '';
                if (dc.function?.name) existing.function.name = dc.function.name;
                if (dc.id) existing.id = dc.id;
              }
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        } catch { /* skip partial JSON */ }
      }
      if (finishReason) break;
    }

    if (finishReason === 'tool_calls' && toolCallsAcc.size > 0 && onToolCalls) {
      onToolCalls(Array.from(toolCallsAcc.values()).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)));
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