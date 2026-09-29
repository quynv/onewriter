import { LANGUAGE_NAMES } from '../levels';
import type { ResolvedConfig } from '../types';
import { stripFrontMatter } from '../front-matter';

export interface PracticeBody {
  source?: string;
  writing: string;
  /** Character offset of `writing` within the body after front matter. */
  writingOffset: number;
}

const SOURCE_HEADING = /^##[ \t]+Source[ \t]*\r?$/gmi;
const WRITING_HEADING = /^##[ \t]+Writing[ \t]*\r?$/gmi;

interface SectionBounds {
  sourceStart: number;
  sourceEnd: number;
  writingOffset: number;
}

/**
 * Recognise the source-writing exercise only when both headings exist in the
 * expected order. Every other document remains on the legacy review path.
 */
export function parsePracticeBody(body: string): PracticeBody {
  const sections = findSections(body);
  if (!sections) return { writing: body, writingOffset: 0 };

  const source = body.slice(sections.sourceStart, sections.sourceEnd).trim();
  if (!source) return { writing: body, writingOffset: 0 };
  return {
    source,
    writing: body.slice(sections.writingOffset).trim(),
    writingOffset: sections.writingOffset,
  };
}

function findSections(body: string): SectionBounds | undefined {
  SOURCE_HEADING.lastIndex = 0;
  const sourceHeading = SOURCE_HEADING.exec(body);
  if (!sourceHeading) return undefined;

  WRITING_HEADING.lastIndex = sourceHeading.index + sourceHeading[0].length;
  const writingHeading = WRITING_HEADING.exec(body);
  if (!writingHeading) return undefined;

  const sourceStart = skipBlankLines(body, sourceHeading.index + sourceHeading[0].length);
  const writingOffset = skipBlankLines(
    body,
    writingHeading.index + writingHeading[0].length,
  );

  return {
    sourceStart,
    sourceEnd: writingHeading.index,
    writingOffset,
  };
}

/** Insert a first source exercise or replace only its existing Source section. */
export function upsertSourceSection(body: string, generated: string): string {
  const sections = findSections(body);
  const writing = sections
    ? body.slice(sections.writingOffset)
    : body.replace(/^(?:[ \t]*\r?\n)+/, '');
  const trailingNewline = writing.endsWith('\n') ? '' : '\n';

  return `## Source\n\n${generated.trim()}\n\n## Writing\n\n${writing}${trailingNewline}`;
}

/** Build the virtual diff document while retaining metadata and reference text. */
export function composeReviewedDocument(document: string, rewritten: string): string {
  const { body, offset } = stripFrontMatter(document);
  const exercise = parsePracticeBody(body);
  return document.slice(0, offset + exercise.writingOffset) + rewritten;
}

/** Model prose must not be able to create OneWriter's reserved boundaries. */
export function isSafeGeneratedSource(value: string): boolean {
  return value.trim().length > 0
    && !/^##[ \t]+(?:Source|Writing)[ \t]*\r?$/mi.test(value);
}

/** Build a plain-text request; the provider's normal REST completion is reused. */
export function buildSourcePrompt(config: ResolvedConfig): string {
  const nativeLanguage = LANGUAGE_NAMES[config.nativeLanguage] ?? config.nativeLanguage;
  const targetLanguage = LANGUAGE_NAMES[config.targetLanguage];

  return `Create a source passage for a foreign-language writing exercise.
Write it in ${nativeLanguage}, the learner's native language.
Topic: ${config.topic ?? ''}
The learner will reproduce the meaning in ${targetLanguage} at ${config.level} level using a ${config.style} style.
Include a coherent sequence of concrete ideas that can be reproduced accurately, but keep the complexity and length realistic for that learner level.
Do not translate it into ${targetLanguage}. Do not include instructions, headings, notes, or markdown.
Reply with only the source passage.`;
}

function skipBlankLines(text: string, from: number): number {
  const match = /^(?:[ \t]*\r?\n)+/.exec(text.slice(from));
  return from + (match?.[0].length ?? 0);
}
