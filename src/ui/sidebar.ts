import * as vscode from 'vscode';
import { nonce } from './html';
import { getTargets, resolveConfig } from '../config';
import { AnkiClient } from '../anki/client';
import { ReviewStore } from '../review/store';
import type { ChunkQueueStore } from '../chunks/store';
import { MessageKey, bundleFor } from '../i18n';
import { t } from '../i18n';
import { getProviderModel, isProviderId, PROVIDERS } from '../llm/providers/types';

/**
 * Màn hình ở Activity Bar. Nó không thay thế Settings của VS Code — những gì ít
 * đổi thì để trong settings.json, còn ở đây chỉ hiện trạng thái hiện tại và
 * những thao tác dùng hằng ngày.
 */
const SIDEBAR_KEYS: MessageKey[] = [
  'sidebar.switch',
  'sidebar.newPractice',
  'sidebar.review',
  'sidebar.openLastReview',
  'sidebar.saveAnki',
  'sidebar.modeHeading',
  'sidebar.modeCodelens',
  'sidebar.modeWebview',
  'sidebar.modeDiff',
  'sidebar.connections',
  'sidebar.checkAnki',
  'sidebar.checking',
  'sidebar.ankiUnknown',
  'sidebar.openSettings',
  'sidebar.noFile',
  'sidebar.remaining',
  'sidebar.chunksWaiting',
  'sidebar.queueHeading',
  'sidebar.queueEmpty',
  'sidebar.clearChunks',
  'sidebar.cleanChunks',
  'sidebar.removeChunk',
];

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'onewriter.panel';

  private view?: vscode.WebviewView;
  private renderedStrings?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ReviewStore,
    private readonly chunkQueue: ChunkQueueStore,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.renderedStrings = undefined;
      }
    });
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => this.handle(message));
    this.refresh();
  }

  private handle(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const value = message as { type?: unknown; value?: unknown; id?: unknown };

    switch (value.type) {
      case 'ready':
        this.refresh();
        break;
      case 'command':
        if (value.value === 'onewriter.switchTarget'
          || value.value === 'onewriter.newPractice'
          || value.value === 'onewriter.review'
          || value.value === 'onewriter.showLastReview'
          || value.value === 'onewriter.saveToAnki') {
          void vscode.commands.executeCommand(value.value);
        }
        break;
      case 'openSettings':
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:onewriter.onewriter',
        );
        break;
      case 'reviewMode':
        if (value.value === 'codelens' || value.value === 'webview' || value.value === 'diff') {
          const mode = value.value;
          const uri = vscode.window.activeTextEditor?.document.uri;
          if (uri && this.store.get(uri)) {
            void vscode.commands.executeCommand('onewriter.showLastReview', uri, mode);
          }
          void vscode.workspace
            .getConfiguration('onewriter')
            .update('review.mode', mode, vscode.ConfigurationTarget.Global)
            .then(() => {
              this.refresh();
            }, () => {
              void vscode.window.showWarningMessage(t('review.modeUpdateFailed'));
            });
        }
        break;
      case 'checkAnki':
        void this.checkAnki();
        break;
      case 'removeChunk':
        if (typeof value.id === 'string') {
          void vscode.commands.executeCommand('onewriter.removeQueuedChunk', value.id);
        }
        break;
      case 'clearChunks':
        void vscode.commands.executeCommand('onewriter.clearCurrentFileChunks');
        break;
      case 'cleanChunks':
        void vscode.commands.executeCommand('onewriter.cleanChunkQueue');
        break;
    }
  }

  private async checkAnki(): Promise<void> {
    try {
      const version = await new AnkiClient().version();
      this.view?.webview.postMessage({
        type: 'anki',
        ok: true,
        text: t('anki.running', { version }),
      });
    } catch (err) {
      this.view?.webview.postMessage({
        type: 'anki',
        ok: false,
        text: (err as Error).message,
      });
    }
  }

  refresh(): void {
    if (!this.view) {
      return;
    }
    const strings = JSON.stringify(bundleFor(SIDEBAR_KEYS));
    if (this.renderedStrings !== undefined && strings !== this.renderedStrings) {
      this.view.webview.html = this.html(this.view.webview);
      return;
    }
    const document = vscode.window.activeTextEditor?.document;
    const config = resolveConfig(document);
    const cfg = vscode.workspace.getConfiguration('onewriter', document?.uri);
    const session = document ? this.store.get(document.uri) : undefined;
    const queuedChunks = document
      ? this.chunkQueue.list(document.uri).map(({ id, chunk, context }) => ({ id, chunk, context }))
      : [];
    const selected = cfg.get<unknown>('llm.provider', 'gemini');
    const provider = isProviderId(selected) ? selected : 'gemini';

    void this.view.webview.postMessage({
      type: 'state',
      payload: {
        language: config.targetLanguage,
        level: config.level,
        style: config.style,
        topic: config.topic ?? '',
        targets: getTargets().map((t) => `${t.language.toUpperCase()} ${t.level}`),
        provider: `${PROVIDERS[provider].label} · ${getProviderModel(cfg, provider)}`,
        reviewMode: session ? this.store.displayMode(session) : config.reviewMode,
        fileName: document?.uri.path.split('/').pop() ?? null,
        issueCount: session ? this.store.pending(session).length : null,
        chunkCount: document ? queuedChunks.length : null,
        queuedChunks,
      },
    });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const strings = JSON.stringify(bundleFor(SIDEBAR_KEYS));
    this.renderedStrings = strings;
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'),
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.js'));

    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
</head>
<body>
<section>
  <h2 id="target">—</h2>
  <p id="context" class="muted"></p>
  <button data-command="onewriter.switchTarget" data-i18n="sidebar.switch" class="ghost"></button>
</section>

<section>
  <button data-command="onewriter.newPractice" data-i18n="sidebar.newPractice"></button>
  <button data-command="onewriter.review" data-i18n="sidebar.review" class="ghost"></button>
  <button data-command="onewriter.showLastReview" data-i18n="sidebar.openLastReview" class="ghost"></button>
</section>

<section aria-labelledby="chunk-queue-heading">
  <h3 id="chunk-queue-heading" data-i18n="sidebar.queueHeading"></h3>
  <p id="chunk-empty" class="muted" data-i18n="sidebar.queueEmpty"></p>
  <div id="chunk-list" class="chunk-list" role="list"></div>
  <button id="save-chunks" data-command="onewriter.saveToAnki" data-i18n="sidebar.saveAnki"></button>
  <button id="clear-chunks" data-i18n="sidebar.clearChunks" class="ghost"></button>
  <button id="clean-chunks" data-i18n="sidebar.cleanChunks" class="ghost"></button>
</section>

<section>
  <h3 data-i18n="sidebar.modeHeading"></h3>
  <label><input type="radio" name="mode" value="codelens"><span data-i18n="sidebar.modeCodelens"></span></label>
  <label><input type="radio" name="mode" value="webview"><span data-i18n="sidebar.modeWebview"></span></label>
  <label><input type="radio" name="mode" value="diff"><span data-i18n="sidebar.modeDiff"></span></label>
</section>

<section>
  <h3 data-i18n="sidebar.connections"></h3>
  <p id="provider" class="muted"></p>
  <p id="anki" class="muted" data-i18n="sidebar.ankiUnknown"></p>
  <button id="check" data-i18n="sidebar.checkAnki" class="ghost"></button>
  <button id="settings" data-i18n="sidebar.openSettings" class="ghost"></button>
</section>

<script nonce="${n}">window.__i18n = ${strings};</script>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }
}
