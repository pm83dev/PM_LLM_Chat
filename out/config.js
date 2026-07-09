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
exports.MAX_FILE_CONTEXT = exports.REQUEST_TIMEOUT_MS = exports.MAX_SUFFIX_CHARS = exports.MAX_PREFIX_CHARS = exports.STOP_SEQUENCES = exports.FIM_MIDDLE = exports.FIM_SUFFIX = exports.FIM_PREFIX = void 0;
exports.loadConfig = loadConfig;
const vscode = __importStar(require("vscode"));
exports.FIM_PREFIX = '<|fim_prefix|>';
exports.FIM_SUFFIX = '<|fim_suffix|>';
exports.FIM_MIDDLE = '<|fim_middle|>';
exports.STOP_SEQUENCES = ['\n\n', exports.FIM_PREFIX, exports.FIM_SUFFIX, exports.FIM_MIDDLE, '<|end|>', '<eos>'];
exports.MAX_PREFIX_CHARS = 3000;
exports.MAX_SUFFIX_CHARS = 1000;
exports.REQUEST_TIMEOUT_MS = 8000;
exports.MAX_FILE_CONTEXT = 3000;
function loadConfig() {
    const ac = vscode.workspace.getConfiguration('pmAutocomplete');
    const ch = vscode.workspace.getConfiguration('pmChat');
    return {
        serverUrl: ac.get('serverUrl', 'http://localhost:8080'),
        actionServerUrl: ac.get('actionServerUrl', ''),
        maxTokens: ac.get('maxTokens', 80),
        temperature: ac.get('temperature', 0.1),
        debounceMs: ac.get('debounceMs', 400),
        enabled: ac.get('enabled', true),
        actionMaxTokens: ac.get('actionMaxTokens', 1024),
        actionTimeoutMs: ac.get('actionTimeoutMs', 60000),
        actionModelFamily: ac.get('actionModelFamily', 'gemma'),
        chatEndpoint: ch.get('endpoint', 'http://localhost:9000/v1/chat/completions'),
        chatModel: ch.get('model', 'gemma4'),
        chatSystemPrompt: ch.get('systemPrompt', 'You are an expert software developer. Use Angular 18 with Signals and standalone components. For .NET use minimal API or Worker Service.'),
        includeRelatedFile: ac.get('includeRelatedFile', true),
        includeDiagnostics: ac.get('includeDiagnostics', true),
    };
}
