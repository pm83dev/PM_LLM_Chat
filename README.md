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

## Chat con il Modello

L'estensione include un **Chat Participant** integrato che puoi usare dalla chat di VS Code (`Ctrl+Shift+G` o cliccando sull'icona chat nella barra laterale).

### Comandi disponibili

| Comando | Descrizione                                                              |
| ------- | ------------------------------------------------------------------------ |
| `/edit` | Modifica il codice selezionato con un'istruzione (richiede selezione)    |
| `/fix`  | Correggi errori nel codice selezionato (mostra diagnostica se abilitata) |

### Riferimenti file (`#file`)

Puoi includere contenuti di file nella chat in due modi:

#### 1. Trascina e rilascia

Tratta un file dall'**Explorer** di VS Code direttamente nella casella della chat. Il contenuto del file verrà aggiunto automaticamente al contesto.

#### 2. Digita `#` seguito dal nome del file

Nella casella della chat, digita `#` e inizia a scrivere il nome del file. Seleziona il file dalla lista che appare. Il contenuto verrà iniettato nel contesto prima del tuo prompt.

**Esempio:**

```text
Spiega cosa fa questo codice #app.ts
```

### Contesto automatico

La chat include automaticamente:

- **File attivo** nell'editor (contenuto completo)
- **File gemello** (es. se stai editando `app.ts`, viene incluso anche `app.html` se esiste)
- **Simboli rilevanti** dall'indice del workspace (Code RAG) — solo quando il prompt ha più di 0 caratteri

Puoi disabilitare il contesto automatico in settings:

```json
{ "pmChat.autoContext": false }
```

### Configurazione Chat (`settings.json`)

```json
{
  "pmChat.endpoint": "http://localhost:9000/v1/chat/completions",
  "pmChat.model": "gemma4",
  "pmChat.systemPrompt": "You are an expert software developer.",
  "pmChat.autoContext": true,
  "pmChat.includeRelatedFile": true,
  "pmChat.includeDiagnostics": false
}
```

## Toggle

Click sull'icona `⚡ PM LLM` nella status bar in basso a destra,  
oppure `Ctrl+Shift+P` → *PM Autocomplete: Toggle On/Off*.
