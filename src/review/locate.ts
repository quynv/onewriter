import * as vscode from 'vscode';
import { Issue } from '../types';
import { log } from '../output';

/**
 * LLM không bao giờ trả offset ký tự đáng tin, nên nó chỉ trả chuỗi `original`
 * và extension tự dò vị trí ở đây. Con trỏ tìm kiếm chạy tiến dần, nhờ vậy hai
 * lỗi giống hệt nhau trong cùng bài sẽ map đúng thứ tự thay vì chồng lên nhau.
 *
 * Issue nào không dò được thì bị loại — thà bỏ sót còn hơn tô sai chỗ.
 */
export function locateIssues(
  document: vscode.TextDocument,
  issues: Issue[],
  bodyOffset = 0,
): Issue[] {
  const text = document.getText();
  const located: Issue[] = [];
  let cursor = bodyOffset;

  for (const issue of issues) {
    const index = findOccurrence(text, issue.original, cursor, bodyOffset);
    if (index < 0) {
      log(`Dropping issue that could not be located: ${JSON.stringify(issue.original).slice(0, 120)}`);
      continue;
    }
    located.push({
      ...issue,
      range: new vscode.Range(
        document.positionAt(index),
        document.positionAt(index + issue.original.length),
      ),
    });
    cursor = index + issue.original.length;
  }

  return located;
}

function findOccurrence(
  text: string,
  needle: string,
  cursor: number,
  bodyOffset: number,
): number {
  if (!needle) {
    return -1;
  }

  const ahead = text.indexOf(needle, cursor);
  if (ahead >= 0) {
    return ahead;
  }

  // LLM có thể liệt kê lỗi không theo thứ tự xuất hiện.
  const anywhere = text.indexOf(needle, bodyOffset);
  if (anywhere >= 0) {
    return anywhere;
  }

  return fuzzyFind(text, needle, bodyOffset);
}

/**
 * Fallback khi LLM đã chuẩn hoá khoảng trắng hoặc dấu nháy trong lúc trích dẫn.
 * So khớp trên bản đã chuẩn hoá, rồi ánh xạ ngược về offset thật.
 */
function fuzzyFind(text: string, needle: string, bodyOffset: number): number {
  const map: number[] = [];
  let normalised = '';
  let lastWasSpace = false;

  for (let i = bodyOffset; i < text.length; i++) {
    const ch = normaliseChar(text[i]);
    if (/\s/.test(ch)) {
      if (lastWasSpace) {
        continue;
      }
      lastWasSpace = true;
      map.push(i);
      normalised += ' ';
      continue;
    }
    lastWasSpace = false;
    map.push(i);
    normalised += ch;
  }

  const target = needle
    .split('')
    .map(normaliseChar)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!target) {
    return -1;
  }
  const hit = normalised.indexOf(target);
  return hit < 0 ? -1 : map[hit];
}

/** Gộp các biến thể nháy và gạch ngang mà LLM hay thay thầm. */
function normaliseChar(ch: string): string {
  switch (ch) {
    case '\u2018':
    case '\u2019':
    case '\u02bc':
      return "'";
    case '\u201c':
    case '\u201d':
      return '"';
    case '\u2013':
    case '\u2014':
      return '-';
    case '\u00a0':
    case '\u3000':
      return ' ';
    default:
      return ch;
  }
}
