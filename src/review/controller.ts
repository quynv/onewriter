import * as vscode from 'vscode';
import { resolveConfig, stripFrontMatter } from '../config';
import { createProvider, requestReview } from '../llm/provider';
import { locateIssues } from './locate';
import { ReviewStore } from './store';
import { DiffRenderer } from './diff';
import { PanelRenderer } from './panel';
import { LLMError } from '../llm/errors';
import { reportLlmError } from '../llm/report';
import { log } from '../output';
import { t } from '../i18n';
import type { ChunkQueueStore } from '../chunks/store';
import type { ReviewMode } from '../types';

export class ReviewController {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ReviewStore,
    private readonly diff: DiffRenderer,
    private readonly panel: PanelRenderer,
    private readonly chunkQueue: ChunkQueueStore,
  ) {}

  async review(document: vscode.TextDocument): Promise<void> {
    const { body, offset } = stripFrontMatter(document.getText());
    if (body.trim().length < 20) {
      vscode.window.showInformationMessage(t('review.tooShort'));
      return;
    }

    const config = resolveConfig(document);
    const llm = await createProvider(this.context, document.uri);
    if (!llm) {
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('review.progress', {
            lang: config.targetLanguage.toUpperCase(),
            level: config.level,
          }),
          cancellable: true,
        },
        (_progress, token) => requestReview(llm, body, config, token),
      );

      // Range do extension tự dò, không lấy từ LLM.
      result.issues = locateIssues(document, result.issues, offset);

      const session = {
        uri: document.uri,
        result,
        config,
        displayMode: config.reviewMode,
        originalText: document.getText(),
        createdAt: Date.now(),
        resolved: new Set<string>(),
      };
      void this.store.set(document.uri, session).catch(() => {
        log('Review result persistence failed.');
        void vscode.window.showWarningMessage(t('review.persistenceFailed'));
      });

      await this.render(document.uri, config.reviewMode);
      this.announce(result.issues.length, result.chunks.length, config.reviewMode);

      // Render the successful review before waiting for durable queue storage.
      if (document.uri.scheme === 'untitled') {
        if (result.chunks.length > 0) await vscode.window.showInformationMessage(t('chunks.untitled'));
        return;
      }
      try {
        await this.chunkQueue.addMany(result.chunks.map((candidate) => ({
          uri: document.uri.toString(),
          chunk: candidate.chunk,
          context: candidate.context,
          targetLanguage: config.targetLanguage,
          nativeLanguage: config.nativeLanguage,
          level: config.level,
          style: config.style,
          source: candidate.source,
        })));
      } catch {
        log('Review chunk queue persistence failed.');
        await vscode.window.showErrorMessage(t('chunks.persistenceFailed'));
      }
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        return;
      }
      const kind = err instanceof LLMError ? err.kind : 'other';
      const status = err instanceof LLMError ? err.status ?? 'none' : 'none';
      log(`Review failed: provider=${llm.name} kind=${kind} status=${status}`);
      await reportLlmError(this.context, err, document.uri, 'review');
    }
  }

  private async render(uri: vscode.Uri, mode: string): Promise<void> {
    if (mode === 'diff') {
      await this.diff.show(uri);
    } else if (mode === 'webview') {
      await this.panel.show(uri);
    }
    // Chế độ codelens tự vẽ khi store phát sự kiện.
  }

  /** Render an existing result in another mode without calling the LLM. */
  async showStored(uri: vscode.Uri, mode: ReviewMode): Promise<boolean> {
    if (!this.store.get(uri)) return false;
    void this.store.setDisplayMode(uri, mode).catch(() => {
      log('Review display mode persistence failed.');
      void vscode.window.showWarningMessage(t('review.persistenceFailed'));
    });
    await this.render(uri, mode);
    return true;
  }

  private announce(issues: number, chunks: number, mode: string): void {
    if (issues === 0) {
      vscode.window.showInformationMessage(
        chunks > 0 ? t('review.cleanWithChunks', { count: chunks }) : t('review.clean'),
      );
      return;
    }
    if (mode === 'codelens') {
      vscode.window.setStatusBarMessage(
        `OneWriter: ${t('review.status', { issues, chunks })}`,
        6000,
      );
    }
  }

  /**
   * Áp dụng một sửa đổi rồi dò lại vị trí các lỗi còn lại, vì mọi offset phía
   * sau chỗ vừa sửa đều đã dịch chuyển.
   */
  async applyIssue(uri: vscode.Uri, issueId: string): Promise<void> {
    const session = this.store.get(uri);
    const issue = session?.result.issues.find((i) => i.id === issueId);
    if (!session || !issue?.range) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    if (this.store.get(uri) !== session) return;

    // Nếu văn bản tại vị trí đó đã đổi thì range cũ không còn đáng tin.
    if (document.getText(issue.range) !== issue.original) {
      vscode.window.showWarningMessage(t('review.stale'));
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, issue.range, issue.replacement);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage(t('review.applyFailed'));
      return;
    }
    if (this.store.get(uri) !== session) return;

    try {
      await this.store.markResolved(uri, issueId);
    } catch {
      log('Resolved review state persistence failed.');
      await vscode.window.showWarningMessage(t('review.persistenceFailed'));
    }

    // A new review may have replaced this session while persistence was slow.
    if (this.store.get(uri) !== session) return;

    const updated = await vscode.workspace.openTextDocument(uri);
    if (this.store.get(uri) !== session) return;
    const { offset } = stripFrontMatter(updated.getText());
    const remaining = this.store.pending(session);
    const relocated = locateIssues(updated, remaining, offset);

    for (const issue of remaining) {
      const match = relocated.find((r) => r.id === issue.id);
      if (match) {
        issue.range = match.range;
      } else {
        // Không dò lại được thì coi như đã xử lý, tránh sửa nhầm chỗ khác.
        session.resolved.add(issue.id);
      }
    }

    if (this.store.get(uri) !== session) return;
    try {
      await this.store.set(uri, session);
    } catch {
      log('Relocated review state persistence failed.');
      await vscode.window.showWarningMessage(t('review.persistenceFailed'));
    }
  }
}
