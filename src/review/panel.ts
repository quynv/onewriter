import * as vscode from 'vscode';
import { ReviewStore } from './store';
import { nonce } from '../ui/html';
import { MessageKey, bundleFor, t } from '../i18n';
import { log } from '../output';

/**
 * Chế độ đắt nhất nhưng cũng là chế độ duy nhất duyệt được từng lỗi kèm giải
 * thích đầy đủ. Webview chỉ hiển thị; mọi thay đổi văn bản đều do extension host
 * thực hiện qua command, nên webview không cần biết gì về vị trí trong file.
 */
const PANEL_KEYS: MessageKey[] = [
  'category.grammar',
  'category.unnatural',
  'category.better',
  'action.apply',
  'action.keep',
  'panel.empty',
  'panel.nothing',
  'panel.saveChunks',
  'panel.allDone',
  'panel.progress',
  'panel.jump',
];

export class PanelRenderer implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private target?: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ReviewStore,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      store.onDidChange((uri) => {
        if (this.target && uri.toString() === this.target.toString()) {
          this.post();
        }
      }),
    );
  }

  async show(uri: vscode.Uri): Promise<void> {
    this.target = uri;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'onewriter.review',
        t('panel.title'),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        },
      );
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.target = undefined;
      });
      this.panel.webview.onDidReceiveMessage((message) => this.handle(message));
    }

    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.post();
  }

  private async handle(message: { type: string; id?: string }): Promise<void> {
    if (!this.target) {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.post();
        break;
      case 'apply':
        void vscode.commands.executeCommand('onewriter.applyIssue', this.target, message.id);
        break;
      case 'skip':
        try {
          await this.store.markResolved(this.target, message.id!);
        } catch {
          log('Skipped review state persistence failed.');
          await vscode.window.showWarningMessage(t('review.persistenceFailed'));
        }
        break;
      case 'reveal':
        void this.reveal(message.id!);
        break;
      case 'anki':
        void vscode.commands.executeCommand('onewriter.saveToAnki', this.target);
        break;
    }
  }

  private async reveal(issueId: string): Promise<void> {
    const session = this.target && this.store.get(this.target);
    const issue = session?.result.issues.find((i) => i.id === issueId);
    if (!session || !issue?.range) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(session.uri);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    editor.selection = new vscode.Selection(issue.range.start, issue.range.end);
    editor.revealRange(issue.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private post(): void {
    if (!this.panel || !this.target) {
      return;
    }
    const session = this.store.get(this.target);
    if (!session) {
      void this.panel.webview.postMessage({ type: 'empty' });
      return;
    }
    void this.panel.webview.postMessage({
      type: 'render',
      payload: {
        fileName: session.uri.path.split('/').pop(),
        level: `${session.config.targetLanguage.toUpperCase()} · ${session.config.level}`,
        comment: session.result.overallComment,
        chunkCount: session.result.chunks.length,
        issues: session.result.issues.map((issue) => ({
          id: issue.id,
          original: issue.original,
          replacement: issue.replacement,
          category: issue.category,
          severity: issue.severity,
          explanation: issue.explanation,
          grammarPoint: issue.grammarPoint,
          done: session.resolved.has(issue.id),
        })),
      },
    });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const strings = JSON.stringify(bundleFor(PANEL_KEYS));
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'),
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));

    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>OneWriter</title>
</head>
<body>
<header>
  <div>
    <h1 id="file"></h1>
    <p id="meta"></p>
  </div>
  <button id="anki" hidden></button>
</header>
<p id="comment"></p>
<div id="list"></div>
<p id="empty"></p>
<script nonce="${n}">window.__i18n = ${strings};</script>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
