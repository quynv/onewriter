export class ChunkSelectionError extends Error {
  constructor(readonly kind: 'empty' | 'tooLong') {
    super(kind);
    this.name = 'ChunkSelectionError';
  }
}

export function normalizeChunk(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

const TERMINATORS = /[.!?。！？]/u;

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(offset)));
}

function lastParagraphBoundary(text: string, before: number): number {
  const prefix = text.slice(0, before);
  let boundary = -1;
  const pattern = /\n\s*\n/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prefix)) !== null) {
    boundary = match.index + match[0].length;
  }
  return boundary;
}

function nextParagraphBoundary(text: string, from: number): number {
  const match = /\n\s*\n/gu.exec(text.slice(from));
  return match ? from + match.index : -1;
}

export function extractChunkSelection(
  text: string,
  startOffset: number,
  endOffset: number,
): { chunk: string; context: string } {
  const first = clampOffset(startOffset, text.length);
  const second = clampOffset(endOffset, text.length);
  let start = Math.min(first, second);
  let end = Math.max(first, second);
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  const chunk = normalizeChunk(text.slice(start, end));
  if (!chunk) throw new ChunkSelectionError('empty');
  if ([...chunk].length > 200) throw new ChunkSelectionError('tooLong');

  let left = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (TERMINATORS.test(text[index])) {
      left = index + 1;
      break;
    }
  }
  const paragraphLeft = lastParagraphBoundary(text, start);
  if (paragraphLeft > left) left = paragraphLeft;

  let right = text.length;
  if (end > start && TERMINATORS.test(text[end - 1])) {
    right = end;
  } else {
    for (let index = end; index < text.length; index += 1) {
      if (TERMINATORS.test(text[index])) {
        right = index + 1;
        break;
      }
    }
  }
  const paragraphRight = nextParagraphBoundary(text, end);
  if (paragraphRight >= 0 && paragraphRight < right) right = paragraphRight;

  const context = normalizeChunk(text.slice(left, right));
  return { chunk, context };
}
