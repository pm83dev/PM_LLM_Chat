"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeController = void 0;
exports.abortActiveRequests = abortActiveRequests;
exports.callServer = callServer;
exports.fetchCompletion = fetchCompletion;
exports.buildActionPrompt = buildActionPrompt;
exports.actionStopSequences = actionStopSequences;
exports.fetchAction = fetchAction;
exports.streamChat = streamChat;
const utils_1 = require("./utils");
const config_1 = require("./config");
function abortActiveRequests() {
    exports.activeController?.abort();
}
async function callServer(prompt, maxTokens, temperature, timeoutMs, stopSequences, signal, serverUrl) {
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
        if (!response.ok) {
            console.error(`[PM] Server error: ${response.status}`);
            return null;
        }
        const data = await response.json();
        return data.content != null ? (0, utils_1.stripThinkTags)(data.content) : null;
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError')
            return null;
        console.error('[PM] Fetch error:', err);
        return null;
    }
}
async function fetchCompletion(prompt, cancelToken, serverUrl, maxTokens, temperature) {
    exports.activeController?.abort();
    exports.activeController = new AbortController();
    const timeoutId = setTimeout(() => exports.activeController?.abort(), config_1.REQUEST_TIMEOUT_MS);
    const cancelDispose = cancelToken.onCancellationRequested(() => exports.activeController?.abort());
    try {
        return await callServer(prompt, maxTokens, temperature, config_1.REQUEST_TIMEOUT_MS, config_1.STOP_SEQUENCES, exports.activeController.signal, serverUrl);
    }
    finally {
        clearTimeout(timeoutId);
        cancelDispose.dispose();
    }
}
function buildActionPrompt(system, user, family) {
    switch (family) {
        case 'gemma': return `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n`;
        case 'llama': return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n${system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n${user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n`;
        case 'qwen':
        default: return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
    }
}
function actionStopSequences(family) {
    switch (family) {
        case 'gemma': return ['<end_of_turn>', '<start_of_turn>', '<eos>'];
        case 'llama': return ['<|eot_id|>', '<|start_header_id|>', '<eos>'];
        case 'qwen':
        default: return ['<|im_end|>', '<|im_start|>', '<eos>'];
    }
}
async function fetchAction(systemPrompt, userContent, actionServerUrl, fallbackUrl, family, actionMaxTokens, actionTimeoutMs // ← da settings, non più costante hardcoded
) {
    exports.activeController?.abort();
    exports.activeController = new AbortController();
    const timeoutId = setTimeout(() => exports.activeController?.abort(), actionTimeoutMs);
    const url = actionServerUrl.trim() || fallbackUrl;
    const prompt = buildActionPrompt(systemPrompt, userContent, family);
    try {
        return await callServer(prompt, actionMaxTokens, 0.2, actionTimeoutMs, actionStopSequences(family), exports.activeController.signal, url);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
async function streamChat(messages, chatEndpoint, chatModel, onChunk, onDone, onError) {
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
        if (!response.ok) {
            onError(`Server error: ${response.status}`);
            return;
        }
        if (!response.body) {
            onError('No response body');
            return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    onDone();
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) {
                        accumulated += content;
                        const clean = (0, utils_1.stripThinkTags)(accumulated);
                        if (clean)
                            onChunk(clean);
                    }
                }
                catch { /* skip partial JSON */ }
            }
        }
        onDone();
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            onError('Request timed out');
        }
        else {
            const msg = err instanceof Error ? `${err.message} — endpoint: ${chatEndpoint}` : String(err);
            onError(msg);
        }
    }
    finally {
        clearTimeout(timeoutId);
    }
}
