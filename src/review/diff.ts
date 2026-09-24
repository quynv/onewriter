import * as vscode from 'vscode';
import { ReviewStore } from './store';
import { t } from '../i18n';

export const DIFF_SCHEME = 'onewriter-suggested';

/**
 * Chế độ rẻ nhất: đẩy bản viết lại vào một virtual document rồi nhờ diff editor
 * của VS Code lo phần so sánh. Đổi lại, người học chỉ nhận hoặc bỏ cả bài chứ
 * không duyệt được từng lỗi.
 */
export class DiffRenderer implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.disposables.push(
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
        onDidChange: this.emitter.event,
        provideTextDocumentContent: (uri) => this.provideContent(uri),
      }),
      store.onDidChange((uri) => this.emitter.fire(toDiffUri(uri))),
    );
  }

  private provideContent(uri: vscode.Uri): string {
    const original = fromDiffUri(uri);
    const session = this.store.get(original);
    if (!session) {
      return '';
    }
    const comment = session.result.overallComment
      ? `<!-- ${session.result.overallComment.replace(/-->/g, '--&gt;')} -->\n\n`
      : '';
    return comment + (session.result.rewritten || session.originalText);
  }

  async show(uri: vscode.Uri): Promise<void> {
    const name = uri.path.split('/').pop() ?? t('panel.text');
    await vscode.commands.executeCommand(
      'vscode.diff',
      uri,
      toDiffUri(uri),
      t('diff.title', { file: name }),
      { preview: false, viewColumn: vscode.ViewColumn.Beside },
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function toDiffUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: DIFF_SCHEME, query: uri.scheme });
}

function fromDiffUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: uri.query || 'file', query: '' });
}
