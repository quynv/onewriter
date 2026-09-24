import { TargetLanguage } from './types';

export const LANGUAGE_NAMES: Record<string, string> = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
};

export const LEVELS_BY_LANGUAGE: Record<TargetLanguage, string[]> = {
  en: ['A2', 'B1', 'B2', 'C1'],
  ja: ['N4', 'N3', 'N2', 'N1'],
};

/**
 * Level quyết định LLM được phép can thiệp tới đâu. Thiếu phần này thì mọi bài
 * đều bị viết lại theo giọng C2 và người học sơ cấp không học được gì.
 */
const POLICIES: Record<string, string> = {
  A2: `The learner is elementary. Only fix errors that make the sentence hard to understand or clearly wrong: verb tense, subject-verb agreement, articles, word order, basic prepositions. Keep sentences short and simple. Do NOT upgrade vocabulary, do NOT introduce clauses or structures the learner did not attempt. A correct-but-plain sentence is a success at this level, so leave it alone.`,

  B1: `The learner is intermediate. Fix grammar errors and wrong collocations. You may point out up to 3 places where a more natural phrasing exists, but keep the learner's own sentence structure. Do not rewrite simple sentences into complex ones.`,

  B2: `The learner is upper-intermediate. Fix grammar, collocation, and phrasing that a native speaker would not use. You may suggest more varied sentence structures and more precise word choice, but preserve the learner's voice and the content of each sentence.`,

  C1: `The learner is advanced. Grammar errors will be rare; focus on register consistency, redundancy, rhythm, and idiomatic precision. Do not touch anything that is already correct and natural. Every suggestion must have a reason more specific than "this sounds better".`,

  N4: `The learner is elementary (JLPT N4). Only fix clear errors: particles (は/が/を/に/で), verb conjugation, adjective forms, and て-form connections. Keep sentences short. Do NOT introduce kanji, vocabulary, or grammar above N4. Do NOT upgrade a correct plain sentence.`,

  N3: `The learner is lower-intermediate (JLPT N3). Fix particle errors, conjugation, transitive/intransitive pairs (自動詞・他動詞), and unnatural word choice. You may suggest up to 3 more natural phrasings using N3-level grammar. Keep kanji usage at N3 level.`,

  N2: `The learner is upper-intermediate (JLPT N2). Fix grammar, particles, and collocations. Pay attention to connective expressions (接続表現) and to sentences that are grammatical but read as translated-from-English. You may suggest N2-level structures.`,

  N1: `The learner is advanced (JLPT N1). Focus on 文体 consistency, redundancy, nuance of near-synonyms, and natural flow between sentences. Do not touch what is already correct and natural. Every suggestion needs a specific reason.`,
};

export function levelPolicy(level: string): string {
  return POLICIES[level] ?? POLICIES.B1;
}

/** Ràng buộc riêng của từng ngôn ngữ, cộng thêm vào chính sách trình độ. */
export function languageNotes(language: TargetLanguage, style: string): string {
  if (language === 'ja') {
    const styleRule =
      style === 'plain'
        ? 'The learner is writing in plain form (だ・である体). Flag any です・ます sentence as a 文体 inconsistency.'
        : style === 'formal'
          ? 'The learner is writing formal written Japanese (硬い書き言葉). Flag colloquial contractions such as ちゃう, とく, じゃ.'
          : 'The learner is writing in polite form (です・ます体). Flag any plain-form sentence ending as a 文体 inconsistency.';
    return `${styleRule}
Treat mixed 文体 within one text as a grammar error, not a style preference.
When a chunk involves a particle or a grammar pattern, name the pattern in grammarPoint (for example "〜において" or "を + 他動詞").`;
  }

  const styleRule =
    style === 'formal'
      ? 'The learner is aiming for formal written English. Flag contractions and conversational fillers.'
      : style === 'plain'
        ? 'The learner is aiming for casual written English. Do not push it toward academic register.'
        : 'The learner is aiming for neutral written English suitable for work or school.';
  return `${styleRule}
When a chunk is a fixed expression, name the pattern in grammarPoint (for example "present perfect + since" or "verb + preposition collocation").`;
}
