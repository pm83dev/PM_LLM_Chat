# PM Autocomplete — Migrazione a Tool Calling Nativo

Data: 12 luglio 2026
Ambito: Chat Participant (`@pm`) — `api.ts`, `chatTools.ts`, `chatRequestHandler.ts`

---

## 1. Problema di partenza

Il chat participant `@pm` allucinava tool inesistenti (Azure IaC Generator, project-setup-info-local, ecc.) e, quando riusciva a invocare i tool reali, il flusso era fragile:

| Sintomo | Causa reale |
|---|---|
| Elenco tool inventato di sana pianta | `toolsAvailable === true` saltava sia la tabella informativa sia il blocco istruzioni XML → il modello non riceveva **nessuna** informazione sui tool reali |
| `cerca file program.cs` → risultati vuoti | `findRelevantSymbols` (pensata per estrarre identificatori da uno snippet di codice) richiedeva match **esatto**, case-sensitive, e filtrava parole senza maiuscole — inadatta a query utente in linguaggio naturale |
| `cerca userservice` (minuscolo) → vuoto anche con simbolo esistente | Stesso problema di match esatto/case-sensitive |
| `#tool:WorkspaceSymbols` ecoato come testo | Il chip nativo VS Code (`request.toolReferences`) non veniva mai risolto — il placeholder letterale finiva dritto nel prompt al modello |
| Sintassi `#tool:...` reinventata dal modello in turni successivi | Il placeholder malformato restava in `context.history` e veniva imitato dal modello nei turni successivi — bug che si autopropaga |
| Comportamento incoerente tra due rami (`toolsAvailable` true/false) | Due sintassi di tool-calling in competizione (XML custom + chip nativo), nessuna delle due realmente strutturata |

**Causa di fondo comune:** nessun vero function calling. I tool venivano descritti *a parole* nel system prompt, e il modello rispondeva *a parole*, in un formato che si inventava di volta in volta. Zero contratto strutturato tra client e modello.

---

## 2. Diagnosi decisiva

Verificato via `curl.exe` diretto a `llama-server` (endpoint `http://100.102.197.68:9000/v1/chat/completions`) con payload OpenAI-style `tools: [...]`:

```
data: {"delta":{"tool_calls":[{"index":0,"function":{"name":"workspace-symbols","arguments":"{"}}]}}
data: {"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"query\":\""}}]}}
data: {"delta":{"tool_calls":[{"index":0,"function":{"arguments":"UserService"}}]}}
...
data: {"finish_reason":"tool_calls"}
```

**Conferma:** Qwen3.6-35B-A3B + llama-server supportano tool calling nativo, grammar-constrained (JSON valido garantito pezzo per pezzo), con `finish_reason: "tool_calls"` pulito. Non serviva alcun fallback testuale — serviva solo smettere di reinventare la ruota con regex e usare il contratto che il server già esponeva.

Confermato anche indirettamente: la stessa infrastruttura (stesso `llama-server`, stesso Qwen) funziona correttamente dentro **Copilot Chat in modalità BYOM**, perché Copilot manda `tools` nel body e legge `tool_calls` in risposta — esattamente il meccanismo che mancava nella nostra estensione.

---

## 3. Soluzione implementata

### `api.ts`
- `ChatMessage` esteso con `role: 'tool'`, `tool_calls`, `tool_call_id`, `name`, `content: string | null`.
- Nuovi tipi `ToolSpec` (schema tool per la request) e `ToolCall` (delta accumulato).
- `streamChat` accetta `tools?: ToolSpec[]` e `onToolCalls?: (calls: ToolCall[]) => void`. Accumula gli `arguments` frammentati per `index` (arrivano a pezzi via SSE, vanno concatenati) e invoca `onToolCalls` solo quando `finish_reason === "tool_calls"`.
- `callServer`, `fetchCompletion`, `fetchAction`, i template per famiglia modello (`qwen`/`llama`/`gemma`) restano **invariati** — `/fix` e `/edit` continuano a usare completion pura via `/completion`, non `/v1/chat/completions`.

### `chatTools.ts`
- Aggiunto `TOOL_SPECS`: schema JSON dei due tool (`current-file`, `workspace-symbols`), passato direttamente a `streamChat`.
- Aggiunto `executeTool(name, rawArguments)`: dispatcher unico, non lancia mai, ritorna sempre una stringa (errore incluso) da rimandare al modello come risultato tool.
- `searchWorkspaceSymbols` ora usa `searchSymbolsByName` (nuova funzione in `indexer.ts`, non mostrata qui ma introdotta in sessione precedente): match case-insensitive per substring, non più uguaglianza esatta case-sensitive.
- Le classi `vscode.lm.registerTool` (`CurrentFileTool`, `WorkspaceSymbolsTool`) restano, ma sono ora esplicitamente un meccanismo **separato**: servono se l'utente usa questi tool dentro Copilot Chat nativo, non dal nostro `@pm`.

### `chatRequestHandler.ts`
- Rimossi: `TOOLS_BLOCK` testuale, istruzioni XML (`<tool:code_suggester...>`), regex di post-processing (`/<tool:(\w+)\.(\w+)>(.*?)<\/tool:\1>/s`), `resolveToolReferences`/gestione chip `#tool:`, tutti i rami `if (!toolsAvailable)` con pattern-matching su "cerca"/"file attivo".
- Aggiunto loop `runChatRound` (max `MAX_TOOL_ROUNDS = 3`): chiama `streamChat` con `TOOL_SPECS`; se il modello richiede tool, esegue via `executeTool`, appende messaggio `assistant` con `tool_calls` + messaggi `tool` con i risultati, ripete il round. Si ferma quando il modello risponde senza altri tool_call o al raggiungimento del limite round.
- `sanitizeHistoryText` mantenuta come rete di sicurezza difensiva per ripulire eventuali residui di sintassi malformata da sessioni precedenti alla migrazione.
- `/fix` e `/edit` restano invariati, su `fetchAction`.

---

## 4. Risultati dei test in sessione

| Test | Esito |
|---|---|
| `@pm quali tool hai a disposizione?` | Elenco corretto, nessuna allucinazione |
| `@pm cerca UserService` | Tool `workspace-symbols` invocato correttamente, risultato reale |
| `@pm cerca userservice` (minuscolo) | Match case-insensitive funzionante |
| `@pm mostrami il file attivo` | Tool `current-file` invocato, risposta con riassunto intelligente del controller (non solo dump grezzo) |
| `@pm cerca quotedto` | Match substring corretto su `QuoteDto` |
| `@pm scrivi una funzione fattoriale` | Nessun tool invocato inutilmente, codice generato correttamente |
| `@pm nella QuoteController aggiungi un endpoint DELETE...` | Codice corretto ma senza marker path → nessun bottone "Applica modifiche" (comportamento atteso, non un bug — vedi §5) |
| `@pm /edit aggiungi endpoint delete...` senza selezione | Bloccato correttamente con warning |
| `@pm /edit aggiungi endpoint delete...` con selezione attiva | Bottone "Applica modifiche" presente e funzionante |

**Conclusione:** la classe di bug (placeholder ecoati, sintassi inventata, propagazione in history, match vuoti) è risolta alla radice. I due percorsi (`chat libera` per esplorazione, `/fix`+`/edit` per modifiche puntuali) funzionano ciascuno per lo scopo per cui è pensato.

---

## 5. Limite noto, non ancora risolto

La chat libera (`@pm`) genera codice valido ma **senza marker di path** (```` ```csharp:percorso/file.cs ````), quindi `parseFileEdits` non ha nulla su cui agganciarsi e il bottone "Applica modifiche" non compare mai fuori da `/fix`/`/edit`. Inoltre il modello tende a omettere parti del file con placeholder (`// ... altri endpoint ...`), il che renderebbe comunque pericoloso un apply automatico anche con marker corretto (sovrascriverebbe codice esistente).

Non è un bug — è una feature mai implementata per questo percorso.

---

## 6. Piano integrazioni future

### 6.1 Apply automatico anche in chat libera (priorità alta se serve nel workflow quotidiano)
- Estendere `pmChat.systemPrompt` (o un blocco iniettato come i vecchi `TOOLS_BLOCK`, ma per l'output atteso, non per i tool) con istruzione esplicita:
  - Formato marker: ```` ```<linguaggio>:<percorso/relativo/file.ext> ````
  - Vincolo tassativo: **file completo, mai placeholder tipo `// resto invariato`** — un apply automatico su un file parziale corrompe il codice esistente.
- Verificare `edits.ts`/`parseFileEdits` per confermare il formato esatto già atteso (probabile riuso 1:1 di quanto già supportato per `/fix`/`/edit`).
- Rischio da gestire: modelli piccoli come Qwen3.6-35B-A3B possono comunque "dimenticare" il vincolo su file lunghi (context window piena, o file oltre gli 8000 caratteri già troncati da `getCurrentFileContent`) — serve un controllo di sanità (diff a righe, o conferma esplicita utente) prima di applicare, non fidarsi ciecamente del marker.

### 6.2 Tool aggiuntivi via lo stesso meccanismo `TOOL_SPECS`/`executeTool`
Ora che il contratto è strutturato, aggiungere un tool è un'estensione a basso rischio (schema JSON + case nel dispatcher), non più un incubo di regex. Candidati concreti dal tuo stack:
- **`search-by-filename`**: complementare a `workspace-symbols` (che cerca per nome simbolo, non per nome file) — risolverebbe il caso `cerca file program.cs` visto in sessione, oggi correttamente rifiutato dal modello per assenza del tool giusto.
- **`list-endpoints`**: filtro sull'indice esistente per `kind === 'endpoint'` (già estratto da `extractCsSymbols` in `indexer.ts`) — utile per query tipo "quali endpoint espone questo controller".
- **`run-reindex`**: wrapper sul comando `/pmAutocomplete.reindex` già menzionato nei messaggi di errore di `searchWorkspaceSymbols`, invocabile dal modello stesso quando rileva un indice mancante/vecchio, invece di limitarsi a dirtelo.
- **Integrazione RAG Qdrant** (già presente nell'agente C# per SYNCRO, collection `syncro_docs`): esporre un tool `search-project-docs` per portare la stessa retrieval anche nella chat VS Code, non solo nell'agente CLI.

### 6.3 Multi-round tool calling più robusto
- `MAX_TOOL_ROUNDS = 3` è un limite prudenziale ma arbitrario — monitorare se in uso reale capita di sbatterci contro (task che richiedono es. `workspace-symbols` → `current-file` su un risultato → altra ricerca). Se sì, valutare se alzarlo o se serve un tool "composito" che faccia più step internamente per ridurre i round.
- Attualmente se un tool fallisce (`executeTool` ritorna stringa di errore), il messaggio va comunque al modello come risultato valido — corretto per far sì che il modello possa reagire ("non ho trovato l'indice, vuoi che suggerisca il reindex?"), ma da monitorare che non generi loop dove il modello ritenta lo stesso tool con lo stesso errore.

### 6.4 Migrazione dell'architettura chat verso Chat Participant API nativa
Coerente con l'obiettivo già menzionato di migrare la chat UI verso la VS Code Chat Participant API nativa: una volta lì, il tool calling strutturato che abbiamo costruito qui (schema JSON + loop round) è direttamente riusabile, perché è lo stesso paradigma che la Participant API nativa si aspetta — nessun lavoro sprecato, anzi propedeutico.

### 6.5 Osservabilità
- Aggiungere logging strutturato (non solo `console.error`) dei round di tool calling — utile per capire in retrospettiva quante volte il modello sceglie di chiamare tool vs rispondere direttamente, e affinare `TOOL_SPECS.description` se le invocazioni sono sotto- o sovra-triggerate.
