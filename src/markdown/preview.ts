import { parseFrontMatter, stripFrontMatter } from '../front-matter';

export interface RenderedFrontMatter {
  html: string;
  endOffset: number;
}

interface MarkdownToken {
  content: string;
  map?: [number, number];
}

interface MarkdownBlockState {
  src: string;
  line: number;
  bMarks: number[];
  tShift: number[];
  push(type: string, tag: string, nesting: number): MarkdownToken;
}

type MarkdownBlockRule = (
  state: MarkdownBlockState,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

export interface MarkdownItLike {
  block: {
    ruler: {
      before(
        anchor: string,
        name: string,
        rule: MarkdownBlockRule,
        options?: { alt?: string[] },
      ): void;
    };
  };
}

export function renderFrontMatterDetails(source: string): RenderedFrontMatter | undefined {
  const { offset } = stripFrontMatter(source);
  if (offset === 0) return undefined;

  const fields = parseFrontMatter(source);
  const blockLines = source.slice(0, offset).split(/\r?\n/);
  if (blockLines.at(-1) === '') blockLines.pop();
  const metadataLines = blockLines.slice(1, -1).filter((line) => line.trim() !== '');
  const isValid = metadataLines.length > 0 && metadataLines.every((line) => {
    const separator = line.indexOf(':');
    return separator > 0 && line.slice(0, separator).trim().length > 0;
  });
  if (!isValid || Object.keys(fields).length === 0) return undefined;

  const topic = fields.topic?.trim() || 'OneWriter';
  const rows = Object.entries(fields)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('');

  return {
    endOffset: offset,
    html: `<details class="onewriter-frontmatter"><summary>${escapeHtml(topic)}</summary><table>${rows}</table></details>`,
  };
}

export function installFrontMatterPreview<T extends MarkdownItLike>(md: T): T {
  md.block.ruler.before('fence', 'onewriter_front_matter', frontMatterRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  return md;
}

function frontMatterRule(
  state: MarkdownBlockState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if (startLine !== 0) return false;
  const startOffset = state.bMarks[startLine] + state.tShift[startLine];
  if (startOffset !== 0) return false;
  const rendered = renderFrontMatterDetails(state.src);
  if (!rendered) return false;
  if (silent) return true;

  const consumed = state.src.slice(0, rendered.endOffset);
  const consumedLines = consumed.split(/\r?\n/).length - (consumed.endsWith('\n') ? 1 : 0);
  state.line = startLine + consumedLines;
  const token = state.push('html_block', '', 0);
  token.content = `${rendered.html}\n`;
  token.map = [startLine, state.line];
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
