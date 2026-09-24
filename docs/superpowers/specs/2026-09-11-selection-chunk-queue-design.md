# OneWriter Selection Chunk Queue Design

**Date:** 2026-09-11
**Status:** Approved in chat; awaiting written-spec review

## Goal

Let a learner select a useful expression in a practice document, add it to a persistent per-workspace chunk queue, and later save selected queued chunks to Anki. At save time, OneWriter uses the configured REST LLM provider to generate the meaning, a new natural example, and an optional short note before creating Anki cards.

The queue survives VS Code restarts. OneWriter can remove queue entries whose source files have been deleted.

## Scope

This change adds:

- An editor-selection command and editor context-menu entry.
- A persistent chunk queue backed by VS Code `workspaceState`.
- A current-file queue section in the OneWriter sidebar.
- Per-item removal, current-file clearing, and deleted-file cleanup.
- A dedicated batch LLM request for enriching queued chunks.
- An Anki save flow that removes only successfully saved entries.
- English, Vietnamese, and Japanese UI strings and automated tests.

This change does not add a full card editor, bidirectional Anki synchronization, automatic phrase detection while typing, cloud queue synchronization, or a new LLM provider/configuration surface.

## User Experience

### Adding a selection

1. The learner selects a phrase in a text editor.
2. They run **OneWriter: Add selection to chunks** from the editor context menu or Command Palette.
3. OneWriter reads the selected text and automatically extracts the complete sentence containing the selection.
4. The chunk is added to the queue for that file and appears immediately in the sidebar.

The command rejects an empty selection. It trims leading/trailing whitespace, collapses internal whitespace used only as formatting, and rejects selections longer than 200 Unicode characters with an actionable message. Japanese text is not required to contain spaces. An unsaved `untitled` document must be saved before a chunk can be queued because it has no durable source URI; ordinary file and remote-workspace URIs are supported.

Sentence extraction expands from the selection to the nearest sentence terminators (`.`, `?`, `!`, `。`, `？`, `！`) or paragraph boundaries. The selected text itself is always preserved as the chunk. If no sentence boundary is found, the non-empty containing paragraph is used as context.

Adding the same normalized chunk from the same file twice does not create a duplicate. The existing entry remains in its original queue position and OneWriter informs the learner that it is already waiting.

### Sidebar queue

The sidebar shows queued chunks for the active file only. Each row displays the chunk, a shortened context sentence, and a remove action. The section contains these actions:

- **Save selected chunks to Anki**
- **Clear chunks for this file**
- **Clean deleted-file chunks**

The save action opens a multi-select Quick Pick so the learner can make a final selection. Cancelling or selecting nothing makes no changes and does not call the LLM.

Clear affects only the active file and asks for confirmation when it would remove entries. Clean scans all queue entries in the current workspace state, removes entries whose source URI no longer exists, and reports the number of entries removed. Clean performs no LLM or Anki requests.

### Saving

After the learner confirms the Quick Pick, OneWriter shows cancellable progress and sends all selected chunks in one LLM request. For every item, the model generates:

- `meaning` in the configured native language;
- `example`, a new natural sentence in the target language appropriate for the stored level and style;
- `note`, a short optional usage or grammar note.

The original containing sentence remains the card's personal context. The generated example is additional learning material, not a correction of the original sentence.

OneWriter then checks Anki duplicates and submits the addable notes in one AnkiConnect operation. Queue entries are removed only when Anki returns a successful note ID. Duplicate, failed, cancelled, and unenriched entries remain available for retry.

## Data Model and Persistence

`ChunkQueueStore` owns the queue and persists a versioned envelope containing the item array in `ExtensionContext.workspaceState` under `onewriter.chunkQueue.v1`.

Each entry contains only the data required to resume the workflow:

```ts
interface QueuedChunk {
  id: string;
  uri: string;
  chunk: string;
  normalizedChunk: string;
  context: string;
  targetLanguage: TargetLanguage;
  nativeLanguage: string;
  level: string;
  style: string;
  source: 'selection' | 'mistake' | 'upgrade';
  addedAt: number;
}
```

The language snapshot is resolved from the source document when the entry is added. Valid front matter continues to take precedence over settings. Capturing the snapshot makes later saves deterministic even if a different file or target becomes active.

The stable `id` is generated locally and is included in the LLM request. Queue identity for duplicate prevention is the canonical URI plus `normalizedChunk`. Normalization trims the selection, normalizes line breaks and formatting whitespace, and applies Unicode NFC; it does not lowercase text or alter punctuation.

The store exposes narrow operations for listing by URI, adding, removing by ID, clearing by URI, removing a set of successfully saved IDs, and cleaning missing source URIs. Each mutation updates `workspaceState` before notifying the sidebar, so UI state never gets ahead of durable state.

Existing review-generated chunks enter the same queue through an adapter that copies their source and context data. The existing review result remains unchanged for rendering. Saving from either the review panel or sidebar operates on the shared queue rather than maintaining a second Anki candidate list.

## Components and Ownership

- `src/chunks/store.ts` owns persistence, normalization, deduplication, queue events, and orphan cleanup.
- `src/chunks/selection.ts` validates an editor selection and extracts its containing sentence.
- `src/chunks/enrich.ts` builds the batch prompt, requests structured LLM output, validates item IDs and fields, and returns successes plus per-item failures.
- `src/anki/save.ts` orchestrates final selection, enrichment, duplicate checks, note creation, and selective queue removal.
- `src/extension.ts` registers commands, adds review candidates to the queue, runs startup cleanup, and wires queue change events to the sidebar.
- `src/ui/sidebar.ts` and `media/sidebar.js` render current-file queue state and dispatch queue actions; the webview never calls the LLM or AnkiConnect directly.
- `src/chunks/schema.ts` owns the structured enrichment schema. Provider adapters and secret handling are reused unchanged.

`ChunkQueueStore` is separate from `ReviewStore`: a review is transient and tied to the exact reviewed document content, while the queue is durable learning intent that must survive edits, review clearing, and restarts.

## LLM Contract

The enrichment request contains an array of items with stable IDs, chunk text, original context, target language, native language, level, and style. It asks for one output item per input ID:

```json
{
  "items": [
    {
      "id": "local-stable-id",
      "meaning": "string",
      "example": "string",
      "note": "string or null"
    }
  ]
}
```

OneWriter uses the currently configured provider and model for the queued entry's workspace resource and retrieves its key through the existing SecretStorage flow. The dedicated prompt does not include the whole document—only the selected chunks and their sentence contexts. This reduces latency, token use, and accidental disclosure.

The response validator accepts only requested IDs, ignores duplicate response IDs after the first valid result, trims fields, and requires non-empty `meaning` and `example`. Unknown IDs are discarded. A missing or invalid item becomes a per-item enrichment failure rather than corrupting another card.

One batch contains entries with one target/native-language/level/style tuple. Because the sidebar saves the active file's queue, this is normally one request. The orchestration still groups by configuration tuple before calling the LLM so review-originated or future multi-file callers cannot mix incompatible instructions.

## Anki Mapping

The existing `OneWriter Chunk` model remains compatible:

| Anki field | Value |
| --- | --- |
| `Chunk` | Selected chunk |
| `Meaning` | LLM-generated meaning |
| `Context` | Original containing sentence |
| `Corrected` | LLM-generated new example |
| `Note` | LLM-generated optional note |
| `Source` | Source filename |

Tags retain the configured tags and add `lang::<language>`, `level::<level>`, and `src::<selection|mistake|upgrade>`.

Duplicate checks continue to use AnkiConnect's first-field behavior through `canAddNotes`. Duplicate queue entries are not silently discarded because the learner may delete or move the existing Anki card before retrying.

## Cleanup Lifecycle

On activation, OneWriter starts a best-effort cleanup after command registration. It parses every stored URI and calls `vscode.workspace.fs.stat`. A `FileNotFound` result marks that URI as orphaned; permission, remote-provider, or transient filesystem errors leave the entries untouched.

Startup cleanup is silent unless persistence fails. The explicit **Clean deleted-file chunks** command uses the same operation and reports its result. It is safe and idempotent: running it repeatedly after the first successful cleanup removes nothing further.

Malformed persisted records are excluded during store loading and are removed the next time the store writes. An unknown future storage version is not overwritten, preventing an older extension version from destroying newer data.

## Error Handling and Recovery

- Missing API key: reuse the provider-aware Set API Key prompt; leave the queue unchanged.
- User cancellation during LLM work: abort the HTTP request and leave every selected entry queued.
- LLM request failure: show the existing sanitized provider/model error; leave every entry queued.
- Partial/invalid LLM output: continue with valid enriched items, keep invalid items queued, and report their count.
- Anki unavailable: show the existing AnkiConnect guidance and keep all entries queued.
- Duplicate Anki note: keep the entry queued and identify it as a duplicate in the result message.
- Partial `addNotes` failure: remove only entries paired with non-null note IDs; keep the rest queued.
- Workspace-state write failure: report that the queue could not be updated and do not claim that an item was added, removed, or saved.

Logs may contain counts, provider/model identifiers, HTTP status, and stable local item IDs. They must not contain API keys, authorization headers, complete document text, full prompt bodies, or remote error prose.

## Commands and Menus

The extension contributes these new commands:

- `onewriter.addSelectionToChunks`
- `onewriter.removeQueuedChunk`
- `onewriter.clearCurrentFileChunks`
- `onewriter.cleanChunkQueue`

`onewriter.addSelectionToChunks` appears in the editor context menu when the editor has a non-empty selection. All commands remain available in the Command Palette with localized titles. Existing `onewriter.saveToAnki` is retained and redirected to the shared queue flow.

## Testing

Tests use mocked VS Code documents, editors, `workspaceState`, `workspace.fs`, LLM providers, and AnkiConnect. No real API or Anki instance is required.

Coverage must include:

- Empty and over-limit selection rejection.
- Sentence extraction for English and Japanese punctuation, paragraph fallback, and multi-line selections.
- Unicode/whitespace normalization and same-file duplicate prevention.
- The same chunk in two files remains two independent entries.
- Queue restoration after constructing a new store over the same workspace state.
- Per-item removal and current-file clearing.
- Startup and explicit cleanup remove only `FileNotFound` entries; other filesystem errors preserve data.
- Front matter language and level are captured ahead of settings fallback.
- Review candidates are adapted into the shared queue without changing review rendering.
- Saving nothing does not call the LLM.
- One-file chunks are enriched in one batch and mapped by stable ID even when results are reordered.
- Unknown, duplicate, missing, and invalid response IDs cannot create mismatched cards.
- Cancellation and total LLM failure preserve all selected entries.
- Partial enrichment saves valid items and preserves invalid items.
- Anki duplicate and `addNotes` failure preserve their queue entries.
- Only successful Anki note IDs remove their matching queue entries.
- Sidebar refreshes after durable queue mutations and displays only the active file's entries.
- Command and editor-context-menu contributions, localization completeness, type checking, and production build.

Final verification is:

```sh
npm test
npm run typecheck
npm run build
```

## Acceptance Criteria

- A learner can select a phrase, add it through the editor context menu, and see it in the active file's sidebar queue.
- The containing sentence is captured automatically for English and Japanese practice text.
- Queue entries persist across extension restarts in workspace state.
- Deleted source files can be cleaned automatically and through an explicit command without removing entries on ambiguous filesystem errors.
- Saving selected entries makes a single batch LLM request per configuration tuple and produces meaning, a new example, and an optional note.
- The existing configured REST provider/model and SecretStorage key flow are reused.
- Anki cards preserve original context and store the generated example separately.
- Cancellation or failure never loses an unsaved queue entry.
- Only Anki-confirmed successful entries leave the queue.
- Existing review, front matter precedence, provider integrations, and Anki model compatibility continue to work.
- Tests, type checking, and the production build pass.
