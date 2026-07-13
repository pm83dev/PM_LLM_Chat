import * as vscode from 'vscode';

export const FIM_PREFIX = '<|fim_prefix|>';
export const FIM_SUFFIX = '<|fim_suffix|>';
export const FIM_MIDDLE = '<|fim_middle|>';
export const STOP_SEQUENCES = ['\n\n', FIM_PREFIX, FIM_SUFFIX, FIM_MIDDLE, '<|end|>', '<eos>'];

export const MAX_PREFIX_CHARS   = 3000;
export const MAX_SUFFIX_CHARS   = 1000;
export const REQUEST_TIMEOUT_MS = 8000;
export const MAX_FILE_CONTEXT   = 3000;

export interface ExtensionConfig {
  serverUrl:          string;
  actionServerUrl:    string;
  maxTokens:          number;
  temperature:        number;
  debounceMs:         number;
  enabled:            boolean;
  actionMaxTokens:    number;
  actionTimeoutMs:    number;
  actionModelFamily:  string;
  chatEndpoint:       string;
  chatModel:          string;
  chatSystemPrompt:   string;
  includeRelatedFile: boolean;
  includeDiagnostics: boolean;
}

export function loadConfig(): ExtensionConfig {
  const ac = vscode.workspace.getConfiguration('pmAutocomplete');
  const ch = vscode.workspace.getConfiguration('pmChat');
  return {
    serverUrl:          ac.get<string>('serverUrl', 'http://localhost:8080'),
    actionServerUrl:    ac.get<string>('actionServerUrl', ''),
    maxTokens:          ac.get<number>('maxTokens', 80),
    temperature:        ac.get<number>('temperature', 0.1),
    debounceMs:         ac.get<number>('debounceMs', 400),
    enabled:            ac.get<boolean>('enabled', true),
    actionMaxTokens:    ac.get<number>('actionMaxTokens', 1024),
    actionTimeoutMs:    ac.get<number>('actionTimeoutMs', 60000),
    actionModelFamily:  ac.get<string>('actionModelFamily', 'gemma'),
    chatEndpoint:       ch.get<string>('endpoint', 'http://localhost:9000/v1/chat/completions'),
    chatModel:          ch.get<string>('model', 'gemma4'),
    chatSystemPrompt:   ch.get<string>('systemPrompt', 'You are an expert software developer. Use Angular 18 with Signals and standalone components. For .NET use minimal API or Worker Service.'),
    includeRelatedFile: ac.get<boolean>('includeRelatedFile', true),
    includeDiagnostics: ac.get<boolean>('includeDiagnostics', true),
  };
}
