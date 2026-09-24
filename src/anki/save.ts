import * as vscode from 'vscode';
import { AnkiClient, AnkiError, AnkiNote } from './client';
import { ensureDeck, ensureModel } from './model';
import { deckName } from '../config';
import { log, showOutput } from '../output';
import { t } from '../i18n';
import type { ChunkQueueStore } from '../chunks/store';
import type { EnrichedChunk, QueuedChunk } from '../chunks/types';
import { requestChunkEnrichment } from '../chunks/enrich';
import { createProvider } from '../llm/provider';
import { LLMError } from '../llm/errors';
import { reportLlmError } from '../llm/report';

export interface SaveDependencies {
  createProvider: typeof createProvider;
  createClient: () => AnkiClient;
  enrich: typeof requestChunkEnrichment;
}

const productionDependencies: SaveDependencies = {
  createProvider,
  createClient: () => new AnkiClient(),
  enrich: requestChunkEnrichment,
};

interface QueuedChunkItem extends vscode.QuickPickItem {
  chunk: QueuedChunk;
}

export async function saveQueuedChunksToAnki(
  context: vscode.ExtensionContext,
  queue: ChunkQueueStore,
  uri: vscode.Uri,
  deps: SaveDependencies = productionDependencies,
): Promise<void> {
  const entries = queue.list(uri);
  if (entries.length === 0) {
    await vscode.window.showInformationMessage(t('anki.noChunks'));
    return;
  }

  const items: QueuedChunkItem[] = entries.map((chunk) => ({
    label: chunk.chunk,
    description: `${chunk.targetLanguage.toUpperCase()} · ${chunk.level}`,
    detail: chunk.context,
    picked: true,
    chunk,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: t('anki.queuePickTitle'),
    placeHolder: t('anki.pickPlaceholder'),
    matchOnDescription: true,
  });
  if (!picked?.length) return;

  const selected = picked.map((item) => item.chunk);
  const counts = { added: 0, duplicates: 0, enrichmentFailed: 0, ankiFailed: 0 };
  let savingToAnki = false;
  let committingQueue = false;
  try {
    const llm = await deps.createProvider(context, uri);
    if (!llm) return;

    const successfulIds = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: t('anki.queueProgress'),
      cancellable: true,
    }, async (_progress, token) => {
      const checkCancellation = (): void => {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
      };
      checkCancellation();
      const groups = new Map<string, QueuedChunk[]>();
      for (const item of selected) {
        const key = JSON.stringify([item.targetLanguage, item.nativeLanguage, item.level, item.style]);
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }

      const enrichment = new Map<string, EnrichedChunk>();
      for (const group of groups.values()) {
        checkCancellation();
        try {
          const result = await deps.enrich(llm, group, token);
          checkCancellation();
          const groupIds = new Set(group.map((item) => item.id));
          for (const enriched of result.enriched) {
            if (groupIds.has(enriched.id) && !enrichment.has(enriched.id)) {
              enrichment.set(enriched.id, enriched);
            }
          }
        } catch (err) {
          checkCancellation();
          if (err instanceof vscode.CancellationError) throw err;
          // The JSON extractor throws this local error; never surface raw model prose.
          const failure = err instanceof Error && err.message === 'No valid JSON found in the model response.'
            ? new LLMError('', false, 'parse') : err;
          const kind = failure instanceof LLMError ? failure.kind : 'other';
          log(`Chunk enrichment failed: kind=${kind}`);
          await reportLlmError(context, failure, uri, 'chunks');
        }
      }

      checkCancellation();
      const valid = selected.filter((item) => enrichment.has(item.id));
      counts.enrichmentFailed = selected.length - valid.length;
      if (valid.length === 0) return;

      savingToAnki = true;
      counts.ankiFailed = valid.length;
      const cfg = vscode.workspace.getConfiguration('onewriter', uri);
      const modelName = cfg.get<string>('anki.modelName', 'OneWriter Chunk');
      const tags = cfg.get<string[]>('anki.tags', ['onewriter']);
      const client = deps.createClient();
      const notes = valid.map((item) => queuedNote(item, enrichment.get(item.id)!, modelName, tags));
      await client.version();
      checkCancellation();
      await ensureModel(client, modelName);
      checkCancellation();
      for (const deck of new Set(notes.map((note) => note.deckName))) {
        await ensureDeck(client, deck);
        checkCancellation();
      }

      const addable = await client.canAddNotes(notes);
      checkCancellation();
      counts.duplicates = valid.filter((_, index) => addable[index] === false).length;
      counts.ankiFailed -= counts.duplicates;
      const chosen = valid.flatMap((item, index) => addable[index] === true ? [{ item, note: notes[index] }] : []);
      if (chosen.length === 0) return;

      const ids = await client.addNotes(chosen.map(({ note }) => note));
      // The request is irreversible: confirmed additions must be reconciled even
      // when cancellation arrived while Anki was processing it.
      const successfulIds = new Set(chosen
        .filter((_, index) => typeof ids[index] === 'number' && Number.isFinite(ids[index]))
        .map(({ item }) => item.id));
      counts.added = successfulIds.size;
      counts.ankiFailed -= counts.added;
      return successfulIds;
    });

    // Anki-confirmed IDs cross into a durable, non-cancellable commit only after
    // the progress operation has ended. Late cancellation cannot undo that result.
    if (successfulIds?.size) {
      committingQueue = true;
      await queue.removeMany(successfulIds);
    }
  } catch (err) {
    if (committingQueue) {
      log(`Anki additions confirmed but chunk queue commit failed: count=${counts.added}`);
      await vscode.window.showErrorMessage(t('anki.queueCommitFailed', { count: counts.added }));
      return;
    }
    if (err instanceof vscode.CancellationError) return;
    if (!savingToAnki || err instanceof LLMError) {
      await reportLlmError(context, err, uri, 'chunks');
      return;
    }
    if (err instanceof AnkiError) {
      const guide = t('action.openGuide');
      const message = err.offline ? t('anki.offline')
        : t('anki.saveFailed', { message: t('llm.requestFailed') });
      const action = await vscode.window.showErrorMessage(message, ...(err.offline ? [guide] : []));
      if (action === guide) {
        void vscode.env.openExternal(vscode.Uri.parse('https://ankiweb.net/shared/info/2055492159'));
      }
    } else {
      log('Saving queued chunks to Anki failed.');
      const openLog = t('action.openLog');
      const action = await vscode.window.showErrorMessage(t('anki.saveFailed', { message: t('llm.requestFailed') }), openLog);
      if (action === openLog) showOutput();
    }
  }

  const summary = t('anki.queueSummary', counts);
  if (counts.enrichmentFailed || counts.ankiFailed) {
    await vscode.window.showWarningMessage(summary);
  } else {
    await vscode.window.showInformationMessage(summary);
  }
}

function queuedNote(item: QueuedChunk, enriched: EnrichedChunk, modelName: string, tags: string[]): AnkiNote {
  return {
    deckName: deckName(item),
    modelName,
    fields: {
      Chunk: escapeHtml(item.chunk),
      Meaning: escapeHtml(enriched.meaning),
      Context: escapeHtml(item.context),
      Corrected: escapeHtml(enriched.example),
      Note: escapeHtml(enriched.note ?? ''),
      Source: escapeHtml(vscode.Uri.parse(item.uri).path.split('/').pop() ?? ''),
    },
    tags: [...tags, `lang::${item.targetLanguage}`, `level::${item.level}`, `src::${item.source}`],
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
