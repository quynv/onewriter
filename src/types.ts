import * as vscode from 'vscode';
import type { LLMProviderId } from './llm/providers/types';

export type TargetLanguage = 'en' | 'ja';
export type IssueCategory = 'grammar' | 'unnatural' | 'better';
export type ReviewMode = 'diff' | 'codelens' | 'webview';

/** Một lỗi hoặc một gợi ý nâng cấp trong bài viết. */
export interface Issue {
  id: string;
  /** Trích nguyên văn từ bài viết. LLM không được sửa đổi chuỗi này. */
  original: string;
  replacement: string;
  category: IssueCategory;
  /** 1 nhẹ, 2 vừa, 3 nặng. */
  severity: 1 | 2 | 3;
  explanation: string;
  grammarPoint?: string;
  /** Vị trí trong document, do extension tự tính bằng cách dò `original`. */
  range?: vscode.Range;
}

/** Một cụm đáng học, ứng viên để tạo card Anki. */
export interface ChunkCandidate {
  id: string;
  /** Cụm 2–6 từ trong ngôn ngữ đang học. */
  chunk: string;
  /** Nghĩa, viết bằng tiếng mẹ đẻ. */
  meaning: string;
  /** Câu người học định viết, làm ngữ cảnh cho card. */
  context: string;
  /** Câu đã sửa, nếu chunk này đến từ một lỗi. */
  corrected?: string;
  note?: string;
  grammarPoint?: string;
  /** mistake = rút từ lỗi của mình, upgrade = cụm hay trong bản viết lại. */
  source: 'mistake' | 'upgrade';
  /** Điền sau khi hỏi AnkiConnect. */
  duplicate?: boolean;
}

/** Kết quả LLM trả về, đã parse và validate. */
export interface ReviewResult {
  issues: Issue[];
  chunks: ChunkCandidate[];
  rewritten: string;
  overallComment: string;
}

/** Cấu hình đã resolve cho một document cụ thể. */
export interface ResolvedConfig {
  nativeLanguage: string;
  targetLanguage: TargetLanguage;
  level: string;
  style: string;
  explanationLanguage: 'native' | 'target';
  showBetter: boolean;
  maxChunks: number;
  reviewMode: ReviewMode;
  topic?: string;
}

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
