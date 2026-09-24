import * as vscode from 'vscode';
import { Issue } from '../types';
import { ReviewStore } from './store';
import { MessageKey, t } from '../i18n';

const SEVERITY_MAP: Record<number, vscode.DiagnosticSeverity> = {
  3: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  1: vscode.DiagnosticSeverity.Information,
};

/**
 * Chế độ inline dùng hai cơ chế sẵn có của VS Code: Diagnostics cho gạch chân
 * và ô Problems, CodeLens cho nút hành động trên từng dòng.
 */
export class InlineRenderer implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('onewriter');
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.disposables.push(
      this.diagnostics,
      this.lensEmitter,
      store.onDidChange((uri) => this.refresh(uri)),
      vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        {
          onDidChangeCodeLenses: this.lensEmitter.event,
          provideCodeLenses: (doc) => this.provideLenses(doc),
        },
      ),
    );
  }

  private refresh(uri: vscode.Uri): void {
    const session = this.store.get(uri);
    if (!session || this.store.displayMode(session) !== 'codelens') {
      this.diagnostics.delete(uri);
      this.lensEmitter.fire();
      return;
    }

    const diagnostics = this.store.pending(session).flatMap((issue) => {
      if (!issue.range) {
        return [];
      }
      const diagnostic = new vscode.Diagnostic(
        issue.range,
        `${t(`category.${issue.category}` as MessageKey)}: ${issue.explanation}`,
        SEVERITY_MAP[issue.severity],
      );
      diagnostic.source = 'OneWriter';
      if (issue.grammarPoint) {
        diagnostic.code = issue.grammarPoint;
      }
      return [diagnostic];
    });

    this.diagnostics.set(uri, diagnostics);
    this.lensEmitter.fire();
  }

  private provideLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.store.get(document.uri);
    if (!session || this.store.displayMode(session) !== 'codelens') {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    for (const issue of this.store.pending(session)) {
      if (!issue.range) {
        continue;
      }
      lenses.push(
        new vscode.CodeLens(issue.range, {
          title: `${icon(issue)} ${truncate(issue.replacement)}`,
          tooltip: issue.explanation,
          command: 'onewriter.applyIssue',
          arguments: [document.uri, issue.id],
        }),
        new vscode.CodeLens(issue.range, {
          title: t('action.why'),
          tooltip: issue.explanation,
          command: 'onewriter.explainIssue',
          arguments: [document.uri, issue.id],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function icon(issue: Issue): string {
  return issue.category === 'better' ? '$(lightbulb)' : '$(pencil)';
}

function truncate(text: string, max = 48): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
