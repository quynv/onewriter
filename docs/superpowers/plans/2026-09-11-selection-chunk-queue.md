# Selection Chunk Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let learners queue selected expressions per file, enrich selected queued items with the configured REST LLM, and remove them only after Anki confirms a successful save.

**Architecture:** Add a durable `ChunkQueueStore` beside the transient `ReviewStore`, plus pure selection extraction and enrichment modules. Extend the existing provider boundary to accept a caller-supplied structured-output schema, then route both manually selected and review-generated chunks through one queue-aware Anki save workflow and sidebar UI.

**Tech Stack:** TypeScript, VS Code Extension API, `ExtensionContext.workspaceState`, existing REST LLM providers and AnkiConnect client, Node test runner, esbuild test bundling

**Spec:** `docs/superpowers/specs/2026-09-11-selection-chunk-queue-design.md`

## Global Constraints

- Persist queue data only in `ExtensionContext.workspaceState` under `onewriter.chunkQueue.v1`.
- Support durable file and remote-workspace URIs; require an `untitled` document to be saved first.
- Valid front matter `lang`, `level`, and `style` override settings when a chunk is added.
- Reject empty selections and selections over 200 Unicode code points.
- Normalize with Unicode NFC and formatting-whitespace collapse; do not lowercase or rewrite punctuation.
- Use the existing configured REST provider/model and SecretStorage lookup; add no provider, SDK, or API-key setting.
- Send only chunk text and its containing sentence to the enrichment LLM, never the complete document.
- One enrichment request per configuration tuple; map output only through stable local IDs.
- Never remove a queue item until Anki returns a non-null note ID for that exact item.
- Do not log API keys, authorization headers, full prompt bodies, remote error prose, or complete document text.
- Keep the existing Anki note model and map generated examples into `Corrected`.
- This directory currently has no Git metadata. Run commit steps only if it is initialized or restored as a Git worktree; do not initialize Git as part of this plan.

---

## File Structure

**Create:**

- `src/chunks/types.ts` — durable queue and enriched-result contracts.
- `src/chunks/selection.ts` — normalization, validation, and containing-sentence extraction.
- `src/chunks/store.ts` — versioned workspace-state persistence, events, deduplication, and orphan cleanup.
- `src/chunks/schema.ts` — chunk enrichment JSON Schema and output-format descriptor.
- `src/chunks/enrich.ts` — prompt construction, configuration grouping, request, and response validation.
- `src/llm/report.ts` — shared safe LLM error presentation used by review and chunk saving.
- `test/chunk-selection.test.js` — pure selection behavior.
- `test/chunk-store.test.js` — persistence, mutation, and cleanup behavior.
- `test/chunk-enrich.test.js` — prompt/schema and hostile response mapping.
- `test/anki-queue-save.test.js` — queue-aware save orchestration.
- `test/chunk-extension.test.js` — command wiring and review-to-queue integration.
- `test/chunk-sidebar.test.js` — sidebar rendering and message dispatch.

**Modify:**

- `src/types.ts` — permit a caller-supplied structured output descriptor.
- `src/llm/schema.ts` — export the review output descriptor.
- `src/llm/provider.ts` — pass the review descriptor explicitly; retain provider factory behavior.
- `src/llm/providers/gemini.ts` — use the supplied schema in `responseJsonSchema`.
- `src/llm/providers/openai.ts` — use the supplied schema/name in Responses structured output.
- `src/llm/providers/claude.ts` — use the supplied schema in `output_config.format`.
- `src/llm/providers/openai-compatible.ts` — accept the common signature while retaining JSON-object mode.
- `src/review/controller.ts` — share LLM error reporting and enqueue review-generated chunks.
- `src/anki/save.ts` — replace session-only saving with the durable queue workflow.
- `src/ui/sidebar.ts`, `media/sidebar.js`, `media/sidebar.css` — display and operate the active file's queue.
- `src/extension.ts` — construct the store, register commands, wire events, and start cleanup.
- `src/i18n.ts` — runtime strings in English, Vietnamese, and Japanese.
- `package.json`, `package.nls.json`, `package.nls.vi.json`, `package.nls.ja.json` — command/menu declarations and localized titles.
- `README.md` — document selection, persistence, cleaning, and save semantics.
- `test/llm-metadata.test.js`, `test/llm-providers.test.js`, `test/llm-factory.test.js`, `test/manifest.test.js` — regression coverage for the widened provider interface and new commands.

---

### Task 1: Queue Types and Selection Extraction

**Files:**
- Create: `src/chunks/types.ts`
- Create: `src/chunks/selection.ts`
- Create: `test/chunk-selection.test.js`

**Interfaces:**
- Produces: `QueuedChunk`, `QueuedChunkInput`, `EnrichedChunk`, `ChunkSource`, `normalizeChunk(text)`, and `extractChunkSelection(text, start, end)`.
- Consumes: existing `TargetLanguage`; no VS Code runtime dependency in the pure selection module.

- [ ] **Step 1: Write failing normalization and sentence tests**

Create `test/chunk-selection.test.js` using `loadTs` and assert exact behavior:

```js
test('normalizes formatting whitespace and NFC without lowercasing', () => {
  assert.equal(normalizeChunk('  Café\n  AU  lait '), 'Café AU lait');
  assert.equal(normalizeChunk('Cafe\u0301'), 'Café');
});

test('extracts the English sentence containing the selection', () => {
  const text = 'First sentence. I look forward to Friday! Last one.';
  const start = text.indexOf('look forward to');
  assert.deepEqual(extractChunkSelection(text, start, start + 15), {
    chunk: 'look forward to', context: 'I look forward to Friday!',
  });
});

test('extracts Japanese context without requiring spaces', () => {
  const text = '朝ご飯を食べた。電車で本を読むよう心掛けている。仕事を始める。';
  const start = text.indexOf('心掛けている');
  assert.deepEqual(extractChunkSelection(text, start, start + '心掛けている'.length), {
    chunk: '心掛けている', context: '電車で本を読むよう心掛けている。',
  });
});
```

Add assertions for paragraph fallback, a selection crossing a line break, reversed offsets, an all-whitespace selection, and 201 code points. Empty and oversized cases must throw `ChunkSelectionError` with `kind` equal to `empty` and `tooLong` respectively.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/chunk-selection.test.js`
Expected: FAIL because `src/chunks/selection.ts` does not exist.

- [ ] **Step 3: Define queue contracts**

Create `src/chunks/types.ts` with these exact public shapes:

```ts
import type { TargetLanguage } from '../types';

export type ChunkSource = 'selection' | 'mistake' | 'upgrade';

export interface QueuedChunk {
  id: string;
  uri: string;
  chunk: string;
  normalizedChunk: string;
  context: string;
  targetLanguage: TargetLanguage;
  nativeLanguage: string;
  level: string;
  style: string;
  source: ChunkSource;
  addedAt: number;
}

export type QueuedChunkInput = Omit<QueuedChunk, 'id' | 'normalizedChunk' | 'addedAt'>;

export interface EnrichedChunk {
  id: string;
  meaning: string;
  example: string;
  note?: string;
}
```

- [ ] **Step 4: Implement the pure extractor**

Create `src/chunks/selection.ts`. Implement `normalizeChunk` as `text.normalize('NFC').replace(/\s+/gu, ' ').trim()`. Implement `extractChunkSelection` by ordering/clamping offsets, validating the normalized selected text, scanning left and right to `.!?。！？` or blank-line boundaries, retaining the right terminator, and normalizing context whitespace. Count length with `[...chunk].length`, not UTF-16 `.length`.

```ts
export class ChunkSelectionError extends Error {
  constructor(readonly kind: 'empty' | 'tooLong') {
    super(kind);
  }
}

export function extractChunkSelection(
  text: string,
  startOffset: number,
  endOffset: number,
): { chunk: string; context: string };
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test test/chunk-selection.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit when Git is available**

```sh
git add src/chunks/types.ts src/chunks/selection.ts test/chunk-selection.test.js
git commit -m "feat: extract selected chunks"
```

---

### Task 2: Durable Queue Store and Deleted-File Cleanup

**Files:**
- Create: `src/chunks/store.ts`
- Create: `test/chunk-store.test.js`

**Interfaces:**
- Consumes: `QueuedChunk`, `QueuedChunkInput`, `normalizeChunk`, `vscode.Memento`, `vscode.workspace.fs.stat`, and `vscode.Uri.parse`.
- Produces: `ChunkQueueStore.list`, `add`, `addMany`, `remove`, `removeMany`, `clear`, `cleanDeleted`, `onDidChange`, and `dispose`.

- [ ] **Step 1: Write failing persistence and mutation tests**

Use an in-memory memento whose `update` records a structured clone. Cover these exact outcomes:

```js
const first = await store.add(input({ uri: 'file:///a.md', chunk: 'look forward to' }));
const duplicate = await store.add(input({ uri: 'file:///a.md', chunk: ' look\nforward to ' }));
assert.equal(first.status, 'added');
assert.equal(duplicate.status, 'duplicate');
assert.equal(store.list('file:///a.md').length, 1);

const restored = new ChunkQueueStore(memento);
assert.equal(restored.list('file:///a.md')[0].chunk, 'look forward to');
```

Also assert: the same normalized chunk in `file:///b.md` is allowed; `removeMany` removes exact IDs; `clear(uri)` affects one file; failed `memento.update` leaves the in-memory list unchanged; malformed records are ignored; and an envelope with `version: 2` is read-only rather than overwritten. Every mutation against an unknown version must reject with `UnsupportedChunkQueueVersionError` before calling `memento.update`.

- [ ] **Step 2: Write failing cleanup tests**

Mock `workspace.fs.stat` so one URI resolves, one throws an object with `code: 'FileNotFound'`, and one throws `code: 'NoPermissions'`. Assert `cleanDeleted()` removes only the missing URI's entries, persists once, emits once, and returns the number of removed entries. A second call must return zero.

- [ ] **Step 3: Run store tests and verify RED**

Run: `node --test test/chunk-store.test.js`
Expected: FAIL because `ChunkQueueStore` does not exist.

- [ ] **Step 4: Implement transactional workspace-state ownership**

Persist this exact envelope:

```ts
interface QueueEnvelope {
  version: 1;
  items: QueuedChunk[];
}

const STORAGE_KEY = 'onewriter.chunkQueue.v1';
```

Expose these signatures:

```ts
class ChunkQueueStore implements vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;
  constructor(private readonly state: vscode.Memento);
  list(uri?: vscode.Uri | string): readonly QueuedChunk[];
  add(input: QueuedChunkInput): Promise<{ status: 'added'; item: QueuedChunk } | { status: 'duplicate'; item: QueuedChunk }>;
  addMany(inputs: readonly QueuedChunkInput[]): Promise<{ added: QueuedChunk[]; duplicates: QueuedChunk[] }>;
  remove(id: string): Promise<boolean>;
  removeMany(ids: ReadonlySet<string>): Promise<number>;
  clear(uri: vscode.Uri | string): Promise<number>;
  cleanDeleted(): Promise<number>;
  dispose(): void;
}
```

Generate IDs with `crypto.randomUUID()`. For every mutation, construct the next array, await `state.update(STORAGE_KEY, { version: 1, items: next })`, then replace the in-memory array and fire the event. Treat only `error.code === 'FileNotFound'` as missing during cleanup.

When stored data has an unknown numeric `version`, retain an empty in-memory view and set the store to read-only. `add`, `addMany`, `remove`, `removeMany`, `clear`, and `cleanDeleted` must throw `UnsupportedChunkQueueVersionError` without writing, which protects data created by a newer extension. Version 1 loading filters malformed records; the next successful mutation persists only validated records.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test test/chunk-store.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit when Git is available**

```sh
git add src/chunks/store.ts test/chunk-store.test.js
git commit -m "feat: persist chunk queue"
```

---

### Task 3: Caller-Supplied Structured Output Schema

**Files:**
- Modify: `src/types.ts`
- Modify: `src/llm/schema.ts`
- Modify: `src/llm/provider.ts`
- Modify: `src/llm/providers/gemini.ts`
- Modify: `src/llm/providers/openai.ts`
- Modify: `src/llm/providers/openai-compatible.ts`
- Modify: `src/llm/providers/claude.ts`
- Modify: `test/llm-metadata.test.js`
- Modify: `test/llm-providers.test.js`
- Modify: `test/llm-factory.test.js`

**Interfaces:**
- Produces: `LLMOutputFormat { name, schema }`, `REVIEW_OUTPUT_FORMAT`, and optional third argument `LLMProvider.complete(prompt, token, format?)`.
- Consumes: existing provider request/response behavior; no change to keys, URLs, timeout, or error classification.

- [ ] **Step 1: Add failing provider contract tests**

Define a small custom format in `test/llm-providers.test.js`:

```js
const format = {
  name: 'onewriter_chunks',
  schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array' } } },
};
```

Call Gemini, OpenAI, and Claude providers with `complete('enrich', token(), format)` and assert their request bodies use `format.schema`; assert OpenAI also uses `format.name`. Call Qwen and DeepSeek with the same argument and assert they retain `response_format: { type: 'json_object' }`. Add a factory test proving review still sends `REVIEW_OUTPUT_FORMAT`.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `node --test test/llm-metadata.test.js test/llm-providers.test.js test/llm-factory.test.js`
Expected: FAIL because providers hard-code `REVIEW_JSON_SCHEMA`.

- [ ] **Step 3: Widen the provider boundary minimally**

Add to `src/types.ts`:

```ts
export interface LLMOutputFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface LLMProvider {
  readonly name: LLMProviderId;
  complete(
    prompt: string,
    token: vscode.CancellationToken,
    format?: LLMOutputFormat,
  ): Promise<string>;
}
```

In `src/llm/schema.ts`, export:

```ts
export const REVIEW_OUTPUT_FORMAT: LLMOutputFormat = {
  name: 'onewriter_review',
  schema: REVIEW_JSON_SCHEMA,
};
```

Each native structured-output provider resolves `const output = format ?? REVIEW_OUTPUT_FORMAT`. Gemini uses `output.schema`; OpenAI uses both `output.name` and `output.schema`; Claude uses `output.schema`. The compatible provider accepts `_format?: LLMOutputFormat` but continues JSON-object mode because its two APIs do not share a strict-schema contract.

Change `requestReview` to call `llm.complete(input, token, REVIEW_OUTPUT_FORMAT)` so the review intent is explicit.

- [ ] **Step 4: Run provider regression tests and typecheck**

Run: `node --test test/llm-metadata.test.js test/llm-providers.test.js test/llm-factory.test.js && npm run typecheck`
Expected: PASS with all original request assertions unchanged except the new configurable schema assertions.

- [ ] **Step 5: Commit when Git is available**

```sh
git add src/types.ts src/llm/schema.ts src/llm/provider.ts src/llm/providers test/llm-metadata.test.js test/llm-providers.test.js test/llm-factory.test.js
git commit -m "refactor: parameterize LLM output schema"
```

---

### Task 4: Batch Chunk Enrichment

**Files:**
- Create: `src/chunks/schema.ts`
- Create: `src/chunks/enrich.ts`
- Create: `test/chunk-enrich.test.js`

**Interfaces:**
- Consumes: `QueuedChunk`, `EnrichedChunk`, `LLMProvider`, `LLMOutputFormat`, `extractJsonObject`, and cancellation token.
- Produces: `CHUNK_OUTPUT_FORMAT`, `buildChunkPrompt(items)`, `normaliseChunkEnrichment(raw, requestedIds)`, and `requestChunkEnrichment(llm, items, token)`.

- [ ] **Step 1: Write failing schema, prompt, and validation tests**

Assert `CHUNK_OUTPUT_FORMAT.name === 'onewriter_chunks'`, top-level required field is `items`, item fields are exactly `id`, `meaning`, `example`, and `note`, and additional properties are forbidden.

Build two queued items and assert the prompt contains their IDs/chunks/contexts and language tuple, but does not contain unrelated sentinel text representing the rest of a document. Assert instructions require meaning in `nativeLanguage`, example in `targetLanguage`, and level/style compliance.

For response validation, use reordered results containing an unknown ID, duplicate ID, blank meaning, numeric example, and valid entries. Assert only the first valid result for each requested ID survives and failures contain the requested IDs that lack a valid result.

- [ ] **Step 2: Run enrichment tests and verify RED**

Run: `node --test test/chunk-enrich.test.js`
Expected: FAIL because enrichment modules do not exist.

- [ ] **Step 3: Implement schema and pure normalization**

Export the exact structured descriptor:

```ts
export const CHUNK_OUTPUT_FORMAT: LLMOutputFormat = {
  name: 'onewriter_chunks',
  schema: {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'meaning', 'example', 'note'],
          properties: {
            id: { type: 'string' }, meaning: { type: 'string' },
            example: { type: 'string' }, note: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};
```

`normaliseChunkEnrichment` returns `{ enriched: EnrichedChunk[]; failedIds: string[] }`. It must whitelist requested IDs, preserve request order in `enriched`, accept only the first valid response per ID, trim fields, require non-empty meaning/example, and convert blank/null note to `undefined`.

- [ ] **Step 4: Implement one-call request behavior**

`buildChunkPrompt` serializes only an array of `{ id, chunk, context }` plus one shared language/level/style instruction. `requestChunkEnrichment` calls:

```ts
const raw = await llm.complete(buildChunkPrompt(items), token, CHUNK_OUTPUT_FORMAT);
return normaliseChunkEnrichment(extractJsonObject(raw), new Set(items.map((item) => item.id)));
```

Reject an empty input before calling the provider. Do not retry in this layer; transport retry and provider-safe errors remain owned by the existing LLM stack.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --test test/chunk-enrich.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit when Git is available**

```sh
git add src/chunks/schema.ts src/chunks/enrich.ts test/chunk-enrich.test.js
git commit -m "feat: enrich queued chunks in batches"
```

---

### Task 5: Queue-Aware Anki Save Workflow and Shared LLM Errors

**Files:**
- Create: `src/llm/report.ts`
- Create: `test/anki-queue-save.test.js`
- Modify: `src/review/controller.ts`
- Modify: `src/anki/save.ts`
- Modify: `src/config.ts`
- Modify: `src/i18n.ts`
- Modify: `test/config.test.js`

**Interfaces:**
- Consumes: `ChunkQueueStore`, `createProvider(context, uri)`, `requestChunkEnrichment`, `AnkiClient`, `ensureModel`, `ensureDeck`, and `deckName`.
- Produces: `saveQueuedChunksToAnki(context, queue, uri)`, observable Anki note mapping through the client boundary, a narrow `deckName` input, and `reportLlmError(context, error, resource, operation)`.

- [ ] **Step 1: Add failing orchestration tests**

Use injected dependency defaults or module mocks to prove:

```js
await saveQueuedChunksToAnki(context, queue, uri, deps);
assert.equal(deps.enrichCalls.length, 1);
assert.deepEqual(deps.enrichCalls[0].map((item) => item.id), ['a', 'b']);
assert.deepEqual(deps.client.addedNotes.map((note) => note.fields.Corrected), ['new A']);
assert.deepEqual(queue.removedIds, ['a']);
```

Cover these separate cases: Quick Pick cancelled means zero LLM calls; total LLM failure removes nothing; partial enrichment sends only valid items to Anki; `canAddNotes === false` leaves the duplicate queued; `addNotes` results `[123, null]` remove only the first paired ID; and cancellation preserves all entries.

Assert note mapping uses original context in `Context`, generated example in `Corrected`, optional note in `Note`, source filename in `Source`, and `src::selection` tag.

- [ ] **Step 2: Run save tests and verify RED**

Run: `node --test test/anki-queue-save.test.js`
Expected: FAIL because queue-aware save does not exist.

- [ ] **Step 3: Extract safe LLM error presentation**

Move `ReviewController.reportError` without changing its current messages/actions into:

```ts
export async function reportLlmError(
  context: vscode.ExtensionContext,
  err: unknown,
  resource?: vscode.Uri,
  operation: 'review' | 'chunks' = 'review',
): Promise<void>;
```

Have `ReviewController` call the exported function with `review`, and the queue save flow call it with `chunks`. Auth, model, quota, network, and secret-redaction handling remain shared. Timeout and parse errors select operation-specific local strings, so chunk enrichment never tells the learner to shorten the whole essay. Run `test/llm-factory.test.js` immediately to prove existing review recovery behavior is preserved.

- [ ] **Step 4: Implement queue save orchestration**

Change the public save signature to:

```ts
export async function saveQueuedChunksToAnki(
  context: vscode.ExtensionContext,
  queue: ChunkQueueStore,
  uri: vscode.Uri,
  deps: SaveDependencies = productionDependencies,
): Promise<void>;
```

`SaveDependencies` contains factory functions for provider/client and the enrichment function so tests do not use network services. Production flow must:

1. Read `queue.list(uri)` and show `anki.noChunks` if empty.
2. Show a multi-select Quick Pick with every entry initially picked.
3. Return unchanged on cancel/empty selection.
4. Group chosen entries by `targetLanguage/nativeLanguage/level/style` and call the LLM once per group under one cancellable `withProgress` operation.
5. Join enrichment results to queued entries only by `id`.
6. Ensure Anki model/deck, build notes, and call `canAddNotes` once for valid enriched entries.
7. Call `addNotes` once for entries marked addable.
8. Await `queue.removeMany(successfulIds)` only for non-null returned note IDs.
9. Report added, duplicate, enrichment-failed, and Anki-failed counts using local translations.

If provider creation returns `undefined`, stop with the queue unchanged. Route `LLMError` through `reportLlmError`. Route `AnkiError` through the existing guide behavior. Never include generated remote prose in logs.

Change `deckName` in `src/config.ts` to accept `Pick<ResolvedConfig, 'targetLanguage' | 'level'>`; its implementation already reads only those two fields. Add a config regression test proving the same deck string is produced from a queue language/level snapshot.

- [ ] **Step 5: Run focused regression tests and typecheck**

Run: `node --test test/anki-queue-save.test.js test/llm-factory.test.js test/config.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit when Git is available**

```sh
git add src/llm/report.ts src/review/controller.ts src/anki/save.ts src/config.ts src/i18n.ts test/anki-queue-save.test.js test/llm-factory.test.js test/config.test.js
git commit -m "feat: save queued chunks through LLM"
```

---

### Task 6: Commands, Review Queue Adapter, and Startup Cleanup

**Files:**
- Create: `test/chunk-extension.test.js`
- Modify: `src/review/controller.ts`
- Modify: `src/extension.ts`
- Modify: `src/i18n.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.vi.json`
- Modify: `package.nls.ja.json`
- Modify: `test/manifest.test.js`

**Interfaces:**
- Consumes: `ChunkQueueStore`, `extractChunkSelection`, `resolveConfig`, `saveQueuedChunksToAnki`, and current editor/document APIs.
- Produces: four contributed queue commands, an editor context-menu item, review-candidate queue insertion, and best-effort activation cleanup.

- [ ] **Step 1: Add failing manifest tests**

Assert the manifest contributes exactly these new command IDs and localizes them in every `package.nls*.json` file:

```js
const queueCommands = [
  'onewriter.addSelectionToChunks',
  'onewriter.removeQueuedChunk',
  'onewriter.clearCurrentFileChunks',
  'onewriter.cleanChunkQueue',
];
for (const id of queueCommands) {
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === id));
}
assert.ok(manifest.contributes.menus['editor/context'].some((entry) =>
  entry.command === 'onewriter.addSelectionToChunks' &&
  entry.when.includes('editorHasSelection')));
```

The context-menu condition intentionally relies on `editorHasSelection` rather than `onewriter.isPracticeFile`, so saved remote-workspace documents remain supported. The command itself rejects only `untitled` documents and invalid selections.

- [ ] **Step 2: Add failing extension behavior tests**

Capture registered command callbacks from `activate`. Assert:

- add-selection rejects `untitled`, empty, and oversized selections with localized messages;
- valid selection uses `document.offsetAt`, `extractChunkSelection`, and `resolveConfig(document)` to add one `QueuedChunkInput`;
- remove and clear await durable store mutations;
- clear asks for confirmation before mutation;
- explicit clean reports the removed count;
- activation triggers one silent `cleanDeleted()` call and logs a failure without showing a success toast;
- `onewriter.saveToAnki` calls the queue workflow without requiring a review session.

- [ ] **Step 3: Run command tests and verify RED**

Run: `node --test test/manifest.test.js test/chunk-extension.test.js`
Expected: FAIL because commands and queue wiring do not exist.

- [ ] **Step 4: Register the queue and selection commands**

Construct `const chunkQueue = new ChunkQueueStore(context.workspaceState)` in `activate`, add it to subscriptions, and pass it to the controller and sidebar. Implement add-selection from `vscode.window.activeTextEditor`; require a non-`untitled` URI, convert selection positions with `offsetAt`, resolve config, and add:

```ts
{
  uri: document.uri.toString(),
  chunk,
  context: sentence,
  targetLanguage: config.targetLanguage,
  nativeLanguage: config.nativeLanguage,
  level: config.level,
  style: config.style,
  source: 'selection',
}
```

Register remove, confirmed current-file clear, explicit clean, and queue-aware save. Start cleanup with `void chunkQueue.cleanDeleted().catch((err) => logError('Chunk queue cleanup failed.', err))` after registrations.

- [ ] **Step 5: Enqueue review-generated candidates**

Pass `ChunkQueueStore` into `ReviewController`. After storing a successful review, call `addMany` with each result chunk mapped to the reviewed document URI and resolved config. Preserve `candidate.context` and `candidate.source`; do not mutate the review result or make queue persistence failure erase the rendered review. Log a local metadata-only failure and show the localized queue-persistence error if the write fails.

- [ ] **Step 6: Add localized command/menu copy**

Add manifest titles and runtime messages for add success/duplicate, empty/too-long/untitled selection, remove, clear confirmation/result, clean result, persistence failure, and mixed save counts in English, Vietnamese, and Japanese. Use parameters only for local counts/chunk labels; never interpolate LLM error prose.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `node --test test/manifest.test.js test/chunk-extension.test.js test/llm-factory.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit when Git is available**

```sh
git add src/extension.ts src/review/controller.ts src/i18n.ts package.json package.nls.json package.nls.vi.json package.nls.ja.json test/manifest.test.js test/chunk-extension.test.js
git commit -m "feat: wire chunk queue commands"
```

---

### Task 7: Sidebar Queue UI

**Files:**
- Create: `test/chunk-sidebar.test.js`
- Modify: `src/ui/sidebar.ts`
- Modify: `media/sidebar.js`
- Modify: `media/sidebar.css`
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: `ChunkQueueStore.list(activeDocument.uri)` and the four queue commands.
- Produces: serializable `queuedChunks` sidebar state and safe webview messages `{ type: 'removeChunk', id }`, `{ type: 'clearChunks' }`, `{ type: 'cleanChunks' }`, and existing command dispatch for save.

- [ ] **Step 1: Write failing sidebar state and dispatch tests**

Construct two queued items for two URI strings, activate `/a.md`, call `refresh`, and assert the posted state contains only `/a.md` with `{ id, chunk, context }`. Change active editor to `/b.md`, refresh, and assert only `/b.md` appears.

Feed the message handler a remove ID containing quotes/markup and assert it is passed only as an opaque command argument—not interpolated into HTML or executed as a command name. Assert clear and clean dispatch their fixed command IDs.

- [ ] **Step 2: Run sidebar tests and verify RED**

Run: `node --test test/chunk-sidebar.test.js`
Expected: FAIL because sidebar state has only the review-session chunk count.

- [ ] **Step 3: Render queue state safely**

Add `queuedChunks` to the state payload from `queue.list(document.uri)`. In the static sidebar HTML, add a queue section containing an empty-state paragraph, a list container, and fixed save/clear/clean buttons. In `media/sidebar.js`, create row elements with `document.createElement` and assign `textContent`; never construct queued content through `innerHTML`.

Each row contains the chunk, a context string truncated visually with CSS, and a button that posts `{ type: 'removeChunk', id: item.id }`. The host validates `id` is a string and executes only the fixed `onewriter.removeQueuedChunk` command. Disable save/clear when the active file has no entries.

- [ ] **Step 4: Refresh from durable queue events**

Subscribe to `chunkQueue.onDidChange(() => sidebar.refresh())` in extension wiring. Keep `ReviewStore` refresh behavior for issue counts, but source `sidebar.chunksWaiting` from the queue length rather than `session.result.chunks.length`.

- [ ] **Step 5: Style and localize the compact list**

Add `.chunk-list`, `.chunk-row`, `.chunk-text`, `.chunk-context`, and `.chunk-remove` rules using VS Code theme variables. Keep remove buttons keyboard-focusable and give them a localized `title`/`aria-label` containing the chunk text. Add all sidebar labels to `SIDEBAR_KEYS` and all three runtime bundles.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `node --test test/chunk-sidebar.test.js test/chunk-extension.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit when Git is available**

```sh
git add src/ui/sidebar.ts media/sidebar.js media/sidebar.css src/i18n.ts src/extension.ts test/chunk-sidebar.test.js test/chunk-extension.test.js
git commit -m "feat: show queued chunks in sidebar"
```

---

### Task 8: Documentation and End-to-End Regression Proof

**Files:**
- Modify: `README.md`
- Modify: any task-owned test or source file only when a failing acceptance check identifies a defect

**Interfaces:**
- Consumes: all completed queue, enrichment, Anki, command, and sidebar behavior.
- Produces: user setup/usage documentation and final acceptance evidence.

- [ ] **Step 1: Update README usage and Anki mapping**

Document this exact path: save the practice file, select a phrase, use the editor context menu, inspect/remove it in the sidebar, press Save, choose queued entries, wait for one batch LLM enrichment, and keep Anki desktop running. Explain per-workspace persistence and both automatic and explicit deleted-file cleanup. Update the Anki field table so `Context` is the original sentence and `Corrected` is the newly generated example.

- [ ] **Step 2: Review documentation against observable behavior**

Read the updated commands in `package.json`, the sidebar labels, and the queue save implementation once, then verify the README describes only actions and guarantees the shipped UI actually exposes. Human documentation is reviewed directly rather than guarded by a brittle source-text assertion.

- [ ] **Step 3: Run every focused feature test together**

Run:

```sh
node --test test/chunk-selection.test.js test/chunk-store.test.js test/chunk-enrich.test.js test/anki-queue-save.test.js test/chunk-extension.test.js test/chunk-sidebar.test.js test/llm-metadata.test.js test/llm-providers.test.js test/llm-factory.test.js test/manifest.test.js
```

Expected: PASS with no network or live Anki access.

- [ ] **Step 4: Run the full verification gate**

Run:

```sh
npm test
npm run typecheck
npm run build
```

Expected: all tests pass, TypeScript reports no errors, and `dist/extension.js` is rebuilt successfully.

- [ ] **Step 5: Inspect production output for secret/content leaks and obsolete save coupling**

Run:

```sh
rg -n "apiKey|authorization|prompt|originalText|saveChunksToAnki\(session|reviewFirst" src/chunks src/anki src/extension.ts dist/extension.js
```

Expected: API-key/header references remain only in existing provider/secret internals; the new chunk modules contain no secret logging or whole-document prompt construction; production save no longer requires a `ReviewSession`.

- [ ] **Step 6: Manual extension-host smoke test**

Open a saved Japanese practice file with `lang: ja`, `level: N2`, select `心掛けている`, and verify: context-menu add; full containing sentence in sidebar; persistence after reload; removal and clear; deleted-file clean; cancellable save; one generated meaning/example/note; and queue removal only after Anki confirms the card. Repeat with an English sentence boundary and verify the provider/model shown in the sidebar is the one used.

- [ ] **Step 7: Commit when Git is available**

```sh
git add README.md dist/extension.js
git commit -m "docs: explain selection chunk queue"
```
