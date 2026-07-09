# PM Autocomplete — Local LLM

Estensione VS Code minimale per inline completion via `llama-server`.  
Niente telemetria, niente cloud, niente dipendenze runtime.

## Installazione

```bash
cd pm-autocomplete
npm install
npm run compile
# oppure per pacchettizzare:
npm run package   # genera pm-autocomplete-0.1.0.vsix
```

Installa il `.vsix` in VS Code:  
`Ctrl+Shift+P` → *Extensions: Install from VSIX...*

## Configurazione (`settings.json`)

```json
{
  "pmAutocomplete.serverUrl": "http://192.168.1.X:8080",
  "pmAutocomplete.maxTokens": 80,
  "pmAutocomplete.temperature": 0.1,
  "pmAutocomplete.debounceMs": 400
}
```

## Token FIM

Usa i token `<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` compatibili con:
- Gemma (tutti i modelli)
- CodeLlama, DeepSeek Coder, Qwen2.5-Coder
- La maggior parte dei modelli serviti con llama-server recente

Se il tuo modello usa token diversi (es. `<PRE>/<SUF>/<MID>` per CodeLlama old-style),  
modifica le costanti in cima a `src/extension.ts`.

## Toggle

Click sull'icona `⚡ PM LLM` nella status bar in basso a destra,  
oppure `Ctrl+Shift+P` → *PM Autocomplete: Toggle On/Off*.
