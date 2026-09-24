import { ChunkCandidate, Issue, IssueCategory, ReviewResult } from '../types';
import { t } from '../i18n';

const CATEGORIES: IssueCategory[] = ['grammar', 'unnatural', 'better'];

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Không tin dữ liệu LLM trả về. Thiếu field thì bỏ mục đó, sai kiểu thì ép về
 * mặc định, thừa mục thì cắt. Mục tiêu là không bao giờ ném lỗi lên UI vì một
 * phần tử hỏng trong mảng.
 */
export function normaliseResult(raw: unknown): ReviewResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Response is not an object.');
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.issues) && typeof obj.rewritten !== 'string') {
    throw new Error('Response has neither issues nor rewritten.');
  }

  const issues: Issue[] = [];
  for (const item of Array.isArray(obj.issues) ? obj.issues : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const it = item as Record<string, unknown>;
    const original = str(it.original);
    const replacement = str(it.replacement);
    if (!original || original === replacement) {
      continue;
    }
    const category = CATEGORIES.includes(it.category as IssueCategory)
      ? (it.category as IssueCategory)
      : 'grammar';
    const severityRaw = Number(it.severity);
    const severity = ([1, 2, 3].includes(severityRaw) ? severityRaw : 2) as 1 | 2 | 3;

    issues.push({
      id: `issue-${issues.length}`,
      original,
      replacement,
      category,
      severity,
      explanation: str(it.explanation, t('explain.none')),
      grammarPoint: str(it.grammarPoint) || undefined,
    });
  }

  const chunks: ChunkCandidate[] = [];
  for (const item of Array.isArray(obj.chunks) ? obj.chunks : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const ch = item as Record<string, unknown>;
    const chunk = str(ch.chunk).trim();
    if (!chunk) {
      continue;
    }
    chunks.push({
      id: `chunk-${chunks.length}`,
      chunk,
      meaning: str(ch.meaning).trim(),
      context: str(ch.context).trim(),
      corrected: str(ch.corrected) || undefined,
      note: str(ch.note) || undefined,
      grammarPoint: str(ch.grammarPoint) || undefined,
      source: ch.source === 'upgrade' ? 'upgrade' : 'mistake',
    });
  }

  return {
    issues,
    chunks,
    rewritten: str(obj.rewritten),
    overallComment: str(obj.overallComment),
  };
}
