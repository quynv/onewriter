import * as vscode from 'vscode';
import { ResolvedConfig, ReviewMode, ReviewResult } from '../types';

const STORAGE_KEY = 'onewriter.reviewSessions.v1';

interface StoredPosition {
  line: number;
  character: number;
}

interface StoredRange {
  start: StoredPosition;
  end: StoredPosition;
}

interface StoredReviewSession {
  uri: string;
  result: Omit<ReviewResult, 'issues'> & {
    issues: Array<Omit<ReviewResult['issues'][number], 'range'> & { range?: StoredRange }>;
  };
  config: ResolvedConfig;
  displayMode: ReviewMode;
  originalText: string;
  createdAt: number;
  resolved: string[];
}

interface ReviewEnvelope {
  version: 1;
  sessions: StoredReviewSession[];
}

export interface ReviewSession {
  uri: vscode.Uri;
  result: ReviewResult;
  config: ResolvedConfig;
  /** Chế độ hiển thị hiện tại; độc lập với cấu hình dùng lúc gọi LLM. */
  displayMode?: ReviewMode;
  /** Bản gốc tại thời điểm chấm, để so sánh và để hoàn tác. */
  originalText: string;
  createdAt: number;
  /** Issue đã được áp dụng hoặc bỏ qua. */
  resolved: Set<string>;
}

/**
 * Một nguồn dữ liệu duy nhất cho cả ba chế độ hiển thị. Renderer chỉ đọc từ đây
 * và vẽ lại khi có sự kiện, nên thêm chế độ thứ tư sau này không phải sửa gì
 * ở phần gọi LLM.
 */
export class ReviewStore implements vscode.Disposable {
  private readonly sessions = new Map<string, ReviewSession>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private pendingMutation: Promise<void> = Promise.resolve();

  readonly onDidChange = this.emitter.event;

  constructor(private readonly state?: vscode.Memento) {
    const stored = state?.get<unknown>(STORAGE_KEY);
    if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.sessions)) {
      return;
    }
    for (const value of stored.sessions) {
      const session = restoreSession(value);
      if (session) this.sessions.set(session.uri.toString(), session);
    }
  }

  set(uri: vscode.Uri, session: ReviewSession): Promise<void> {
    session.displayMode ??= session.config.reviewMode;
    this.sessions.set(uri.toString(), session);
    this.emitter.fire(uri);
    this.syncContext();
    if (uri.scheme === 'untitled') return Promise.resolve();
    return this.persist();
  }

  get(uri: vscode.Uri): ReviewSession | undefined {
    return this.sessions.get(uri.toString());
  }

  clear(uri: vscode.Uri): Promise<void> {
    this.sessions.delete(uri.toString());
    this.emitter.fire(uri);
    this.syncContext();
    if (uri.scheme === 'untitled') return Promise.resolve();
    return this.persist();
  }

  markResolved(uri: vscode.Uri, issueId: string): Promise<void> {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      return Promise.resolve();
    }
    session.resolved.add(issueId);
    this.emitter.fire(uri);
    if (session.uri.scheme === 'untitled') return Promise.resolve();
    return this.persist();
  }

  setDisplayMode(uri: vscode.Uri, mode: ReviewMode): Promise<boolean> {
    const session = this.sessions.get(uri.toString());
    if (!session) return Promise.resolve(false);
    session.displayMode = mode;
    this.emitter.fire(uri);
    if (session.uri.scheme === 'untitled') return Promise.resolve(true);
    return this.persist().then(() => true);
  }

  displayMode(session: ReviewSession): ReviewMode {
    return session.displayMode ?? session.config.reviewMode;
  }

  async cleanDeleted(): Promise<number> {
    const missing: Array<[string, ReviewSession]> = [];
    for (const [key, session] of this.sessions) {
      try {
        await vscode.workspace.fs.stat(session.uri);
      } catch (error: unknown) {
        if (isFileNotFound(error)) missing.push([key, session]);
      }
    }
    let removed = 0;
    for (const [key, checkedSession] of missing) {
      if (this.sessions.get(key) !== checkedSession) continue;
      this.sessions.delete(key);
      this.emitter.fire(checkedSession.uri);
      removed++;
    }
    if (removed === 0) return 0;
    this.syncContext();
    await this.persist();
    return removed;
  }

  pending(session: ReviewSession) {
    return session.result.issues.filter((i) => !session.resolved.has(i.id));
  }

  private syncContext(): void {
    const active = vscode.window.activeTextEditor?.document.uri;
    void vscode.commands.executeCommand(
      'setContext',
      'onewriter.hasReview',
      active ? this.sessions.has(active.toString()) : false,
    );
  }

  refreshContext(): void {
    this.syncContext();
  }

  dispose(): void {
    this.emitter.dispose();
    this.sessions.clear();
  }

  private persist(): Promise<void> {
    if (!this.state) return Promise.resolve();
    const envelope: ReviewEnvelope = {
      version: 1,
      sessions: [...this.sessions.values()]
        .filter((session) => session.uri.scheme !== 'untitled')
        .map(storeSession),
    };
    const result = this.pendingMutation.then(() => this.state!.update(STORAGE_KEY, envelope));
    this.pendingMutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function storeSession(session: ReviewSession): StoredReviewSession {
  return {
    uri: session.uri.toString(),
    result: {
      ...session.result,
      issues: session.result.issues.map((issue) => ({
        ...issue,
        range: issue.range ? {
          start: { line: issue.range.start.line, character: issue.range.start.character },
          end: { line: issue.range.end.line, character: issue.range.end.character },
        } : undefined,
      })),
    },
    config: session.config,
    displayMode: session.displayMode ?? session.config.reviewMode,
    originalText: session.originalText,
    createdAt: session.createdAt,
    resolved: [...session.resolved],
  };
}

function restoreSession(value: unknown): ReviewSession | undefined {
  if (!isRecord(value)
    || typeof value.uri !== 'string'
    || !isRecord(value.result)
    || !Array.isArray(value.result.issues)
    || !Array.isArray(value.result.chunks)
    || typeof value.result.rewritten !== 'string'
    || typeof value.result.overallComment !== 'string'
    || !isResolvedConfig(value.config)
    || typeof value.originalText !== 'string'
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || !Array.isArray(value.resolved)
    || !value.resolved.every((item) => typeof item === 'string')
    || !value.result.issues.every(isStoredIssue)
    || !value.result.chunks.every(isStoredChunk)) {
    return undefined;
  }
  try {
    const uri = vscode.Uri.parse(value.uri);
    if (!uri.scheme || uri.scheme === 'untitled') return undefined;
    const issues = value.result.issues.map((issue) => ({
      ...issue,
      range: restoreRange(issue.range),
    })) as ReviewResult['issues'];
    return {
      uri,
      result: {
        issues,
        chunks: value.result.chunks.map((chunk) => ({ ...chunk })) as ReviewResult['chunks'],
        rewritten: value.result.rewritten,
        overallComment: value.result.overallComment,
      },
      config: { ...value.config },
      displayMode: isReviewMode(value.displayMode) ? value.displayMode : value.config.reviewMode,
      originalText: value.originalText,
      createdAt: value.createdAt,
      resolved: new Set(value.resolved),
    };
  } catch {
    return undefined;
  }
}

function restoreRange(value: unknown): vscode.Range | undefined {
  if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) return undefined;
  return new vscode.Range(
    value.start.line, value.start.character, value.end.line, value.end.character,
  );
}

function isPosition(value: unknown): value is StoredPosition {
  return isRecord(value)
    && Number.isInteger(value.line) && value.line >= 0
    && Number.isInteger(value.character) && value.character >= 0;
}

function isReviewMode(value: unknown): value is ReviewMode {
  return value === 'diff' || value === 'codelens' || value === 'webview';
}

function isResolvedConfig(value: unknown): value is ResolvedConfig {
  return isRecord(value)
    && typeof value.nativeLanguage === 'string'
    && (value.targetLanguage === 'en' || value.targetLanguage === 'ja')
    && typeof value.level === 'string'
    && typeof value.style === 'string'
    && (value.explanationLanguage === 'native' || value.explanationLanguage === 'target')
    && typeof value.showBetter === 'boolean'
    && typeof value.maxChunks === 'number' && Number.isFinite(value.maxChunks)
    && isReviewMode(value.reviewMode)
    && (value.topic === undefined || typeof value.topic === 'string');
}

function isStoredIssue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.original === 'string'
    && typeof value.replacement === 'string'
    && (value.category === 'grammar' || value.category === 'unnatural' || value.category === 'better')
    && (value.severity === 1 || value.severity === 2 || value.severity === 3)
    && typeof value.explanation === 'string'
    && (value.grammarPoint === undefined || typeof value.grammarPoint === 'string')
    && (value.range === undefined || isStoredRange(value.range));
}

function isStoredChunk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.chunk === 'string'
    && typeof value.meaning === 'string'
    && typeof value.context === 'string'
    && (value.source === 'mistake' || value.source === 'upgrade')
    && optionalString(value.corrected)
    && optionalString(value.note)
    && optionalString(value.grammarPoint)
    && (value.duplicate === undefined || typeof value.duplicate === 'boolean');
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStoredRange(value: unknown): value is StoredRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'FileNotFound';
}
