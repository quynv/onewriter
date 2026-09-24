const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n-{3,}[ \t]*(?:\r?\n|$)/;

/** Parser front matter tối giản: chỉ `key: value`, đủ dùng và không cần dependency. */
export function parseFrontMatter(text: string): Record<string, string> {
  const match = FRONT_MATTER.exec(text);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = value;
  }
  return result;
}

/** Phần thân bài, bỏ front matter. Trả kèm offset để map range về document gốc. */
export function stripFrontMatter(text: string): { body: string; offset: number } {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { body: text, offset: 0 };
  return { body: text.slice(match[0].length), offset: match[0].length };
}
