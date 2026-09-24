import * as vscode from 'vscode';
import { getTargets, isPracticeFile, resolveConfig, stripFrontMatter } from './config';
import { LEVELS_BY_LANGUAGE, LANGUAGE_NAMES } from './levels';
import { t } from './i18n';
import { ReviewMode, TargetLanguage } from './types';
import { initOutput, log, logError } from './output';
import { deleteApiKey, migrateLegacyLlmConfig, promptForApiKey } from './llm/secrets';
import type { LLMProviderId } from './llm/providers/types';
import { AnkiClient } from './anki/client';
import { saveQueuedChunksToAnki } from './anki/save';
import { ChunkQueueStore } from './chunks/store';
import { ChunkSelectionError, extractChunkSelection } from './chunks/selection';
import { ReviewStore } from './review/store';
import { InlineRenderer } from './review/inline';
import { DiffRenderer } from './review/diff';
import { PanelRenderer } from './review/panel';
import { ReviewController } from './review/controller';
import { SidebarProvider } from './ui/sidebar';
import { installFrontMatterPreview, type MarkdownItLike } from './markdown/preview';

export function extendMarkdownIt(md: MarkdownItLike): MarkdownItLike {
  return installFrontMatterPreview(md);
}

export interface OneWriterExtensionApi {
  extendMarkdownIt(md: MarkdownItLike): MarkdownItLike;
}

export async function activate(context: vscode.ExtensionContext): Promise<OneWriterExtensionApi> {
  initOutput();
  log('OneWriter activated.');

  try {
    await migrateLegacyLlmConfig(context);
  } catch {
    vscode.window.showWarningMessage(t('auth.migrationFailed'));
  }

  const store = new ReviewStore(context.workspaceState);
  const chunkQueue = new ChunkQueueStore(context.workspaceState);
  const inline = new InlineRenderer(store);
  const diff = new DiffRenderer(store);
  const panel = new PanelRenderer(store, context.extensionUri);
  const controller = new ReviewController(context, store, diff, panel, chunkQueue);
  const sidebar = new SidebarProvider(context.extensionUri, store, chunkQueue);

  context.subscriptions.push(store, chunkQueue, inline, diff, panel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
  );

  const syncContext = () => {
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand(
      'setContext',
      'onewriter.isPracticeFile',
      editor ? isPracticeFile(editor.document) : false,
    );
    store.refreshContext();
    sidebar.refresh();
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(syncContext),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('onewriter')) {
        syncContext();
      }
    }),
    store.onDidChange(() => sidebar.refresh()),
    chunkQueue.onDidChange(() => sidebar.refresh()),
  );
  syncContext();

  context.subscriptions.push(
    vscode.commands.registerCommand('onewriter.review', async (uri?: vscode.Uri) => {
      let document = await documentFor(uri);
      if (!document) {
        vscode.window.showInformationMessage(t('review.openFileFirst'));
        return;
      }
      if (document.isDirty || document.uri.scheme === 'untitled') {
        const wasActive = vscode.window.activeTextEditor?.document === document;
        if (!await document.save()) return;
        // Save As can close the untitled document and replace its editor with a
        // new durable document. Do not follow unrelated active-editor changes.
        const saved = vscode.window.activeTextEditor?.document;
        if (document.uri.scheme === 'untitled' && document.isClosed && wasActive
          && saved && saved.uri.scheme !== 'untitled' && !saved.isClosed) {
          document = saved;
        }
      }
      if (document.uri.scheme === 'untitled') {
        await vscode.window.showInformationMessage(t('chunks.untitled'));
        return;
      }
      await controller.review(document);
    }),

    vscode.commands.registerCommand(
      'onewriter.applyIssue',
      (uri: vscode.Uri, issueId: string) => controller.applyIssue(uri, issueId),
    ),

    vscode.commands.registerCommand(
      'onewriter.showLastReview',
      async (uri?: vscode.Uri, requestedMode?: ReviewMode) => {
        const document = await documentFor(uri);
        if (!document) {
          await vscode.window.showInformationMessage(t('review.openFileFirst'));
          return;
        }
        const session = store.get(document.uri);
        if (!session) {
          await vscode.window.showInformationMessage(t('review.noneSaved'));
          return;
        }
        const mode = isReviewMode(requestedMode)
          ? requestedMode
          : store.displayMode(session);
        await controller.showStored(document.uri, mode);
      },
    ),

    vscode.commands.registerCommand(
      'onewriter.explainIssue',
      async (uri: vscode.Uri, issueId: string) => {
        const session = store.get(uri);
        const issue = session?.result.issues.find((i) => i.id === issueId);
        if (!issue) {
          return;
        }
        const heading = issue.grammarPoint ? `${issue.grammarPoint} — ` : '';
        const apply = t('action.apply');
        const action = await vscode.window.showInformationMessage(
          `${heading}${issue.explanation}`,
          { modal: false },
          apply,
        );
        if (action === apply) {
          await controller.applyIssue(uri, issueId);
        }
      },
    ),

    vscode.commands.registerCommand('onewriter.saveToAnki', async (uri?: vscode.Uri) => {
      const document = await documentFor(uri);
      if (!document) {
        vscode.window.showInformationMessage(t('review.openFileFirst'));
        return;
      }
      await saveQueuedChunksToAnki(context, chunkQueue, document.uri);
    }),

    vscode.commands.registerCommand('onewriter.addSelectionToChunks', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage(t('review.openFileFirst'));
        return;
      }
      const { document, selection } = editor;
      if (document.uri.scheme === 'untitled') {
        vscode.window.showInformationMessage(t('chunks.untitled'));
        return;
      }
      try {
        const { body, offset } = stripFrontMatter(document.getText());
        const start = document.offsetAt(selection.start);
        const end = document.offsetAt(selection.end);
        if (Math.min(start, end) < offset) {
          await vscode.window.showInformationMessage(t('chunks.frontMatter'));
          return;
        }
        const { chunk, context: sentence } = extractChunkSelection(
          body, start - offset, end - offset,
        );
        const config = resolveConfig(document);
        const result = await chunkQueue.add({
          uri: document.uri.toString(), chunk, context: sentence,
          targetLanguage: config.targetLanguage, nativeLanguage: config.nativeLanguage,
          level: config.level, style: config.style, source: 'selection',
        });
        await vscode.window.showInformationMessage(
          t(result.status === 'added' ? 'chunks.added' : 'chunks.duplicate', { chunk }),
        );
      } catch (err) {
        if (err instanceof ChunkSelectionError) {
          await vscode.window.showInformationMessage(t(err.kind === 'empty' ? 'chunks.empty' : 'chunks.tooLong'));
        } else {
          await reportQueuePersistenceFailure();
        }
      }
    }),

    vscode.commands.registerCommand('onewriter.removeQueuedChunk', async (id?: string) => {
      if (!id) {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) {
          vscode.window.showInformationMessage(t('review.openFileFirst'));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          chunkQueue.list(document.uri).map((item) => ({ label: item.chunk, detail: item.context, id: item.id })),
          { title: t('chunks.pickRemove') },
        );
        if (!picked) return;
        id = picked.id;
      }
      try {
        if (await chunkQueue.remove(id)) {
          await vscode.window.showInformationMessage(t('chunks.removed'));
        }
      } catch {
        await reportQueuePersistenceFailure();
      }
    }),

    vscode.commands.registerCommand('onewriter.clearCurrentFileChunks', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        vscode.window.showInformationMessage(t('review.openFileFirst'));
        return;
      }
      const confirm = t('chunks.clearAction');
      const answer = await vscode.window.showWarningMessage(t('chunks.clearConfirm'), { modal: true }, confirm);
      if (answer !== confirm) return;
      try {
        const count = await chunkQueue.clear(document.uri);
        await vscode.window.showInformationMessage(t('chunks.cleared', { count }));
      } catch {
        await reportQueuePersistenceFailure();
      }
    }),

    vscode.commands.registerCommand('onewriter.cleanChunkQueue', async () => {
      try {
        const count = await chunkQueue.cleanDeleted();
        await vscode.window.showInformationMessage(t('chunks.cleaned', { count }));
      } catch {
        await reportQueuePersistenceFailure();
      }
    }),

    vscode.commands.registerCommand('onewriter.clearReview', async (uri?: vscode.Uri) => {
      const document = await documentFor(uri);
      if (document) {
        try {
          await store.clear(document.uri);
        } catch {
          logError('Review result removal persistence failed.');
          await vscode.window.showWarningMessage(t('review.persistenceFailed'));
        }
      }
    }),

    vscode.commands.registerCommand('onewriter.setApiKey', (provider?: LLMProviderId) => promptForApiKey(context, provider)),

    vscode.commands.registerCommand('onewriter.deleteApiKey', () => deleteApiKey(context)),

    vscode.commands.registerCommand('onewriter.checkAnki', async () => {
      try {
        const version = await new AnkiClient().version();
        vscode.window.showInformationMessage(t('anki.running', { version }));
      } catch (err) {
        vscode.window.showErrorMessage((err as Error).message);
      }
    }),

    vscode.commands.registerCommand('onewriter.switchTarget', async () => {
      await switchTarget();
      sidebar.refresh();
    }),

    vscode.commands.registerCommand('onewriter.newPractice', () => newPractice()),
  );

  // Persistence errors may contain document text or paths; log only a local label.
  void chunkQueue.cleanDeleted().catch(() => logError('Chunk queue cleanup failed.'));
  void store.cleanDeleted().catch(() => logError('Review result cleanup failed.'));

  return { extendMarkdownIt };
}

function isReviewMode(value: unknown): value is ReviewMode {
  return value === 'diff' || value === 'codelens' || value === 'webview';
}

async function reportQueuePersistenceFailure(): Promise<void> {
  logError('Chunk queue persistence failed.');
  await vscode.window.showErrorMessage(t('chunks.persistenceFailed'));
}

/**
 * Chọn ngôn ngữ, trình độ, rồi văn thể — và ghi thẳng vào `onewriter.targets`.
 * Nâng trình độ là thao tác hay dùng nhất sau vài tuần, nên nó không được bắt
 * người dùng mở settings.json.
 */
async function switchTarget(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('onewriter');
  const targets = getTargets();

  const language = await pick<TargetLanguage>(
    (Object.keys(LEVELS_BY_LANGUAGE) as TargetLanguage[]).map((code) => {
      const existing = targets.find((entry) => entry.language === code);
      return {
        label: LANGUAGE_NAMES[code],
        description: existing ? `${code} · ${existing.level}` : code,
        value: code,
      };
    }),
    t('target.pickLanguage'),
  );
  if (!language) {
    return;
  }

  const current = targets.find((entry) => entry.language === language);

  const level = await pick<string>(
    LEVELS_BY_LANGUAGE[language].map((value) => ({
      label: value,
      description: value === current?.level ? '$(check)' : undefined,
      value,
    })),
    t('target.pickLevel'),
    language === 'ja' ? t('target.levelHintJa') : t('target.levelHintEn'),
  );
  if (!level) {
    return;
  }

  const style = await pick<string>(
    (['plain', 'polite', 'formal'] as const).map((value) => ({
      label: t(`target.style.${value}` as const),
      description: value === current?.style ? '$(check)' : undefined,
      value,
    })),
    t('target.pickStyle'),
  );
  if (!style) {
    return;
  }

  const updated = targets.filter((entry) => entry.language !== language);
  updated.push({ language, level, style });
  updated.sort((a, b) => a.language.localeCompare(b.language));

  await cfg.update('targets', updated, vscode.ConfigurationTarget.Global);
  await cfg.update('activeTarget', language, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    t('target.saved', { lang: LANGUAGE_NAMES[language], level }),
  );
}

interface Choice<T> extends vscode.QuickPickItem {
  value: T;
}

async function pick<T>(
  items: Array<Choice<T>>,
  title: string,
  placeHolder?: string,
): Promise<T | undefined> {
  const chosen = await vscode.window.showQuickPick(items, { title, placeHolder });
  return chosen?.value;
}

async function documentFor(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  return vscode.window.activeTextEditor?.document;
}

/** Tạo file nháp có sẵn front matter, để mỗi bài tự mang theo ngôn ngữ và trình độ. */
async function newPractice(): Promise<void> {
  const config = resolveConfig(vscode.window.activeTextEditor?.document);

  const topic = await vscode.window.showInputBox({
    title: t('practice.title'),
    prompt: t('practice.prompt'),
    placeHolder: t('practice.placeholder'),
  });
  if (topic === undefined) {
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const content = `---
lang: ${config.targetLanguage}
level: ${config.level}
style: ${config.style}
topic: ${topic}
date: ${date}
---

`;

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content,
  });
  const editor = await vscode.window.showTextDocument(document);
  const end = new vscode.Position(document.lineCount, 0);
  editor.selection = new vscode.Selection(end, end);
}

export function deactivate(): void {
  log('OneWriter deactivated.');
}
