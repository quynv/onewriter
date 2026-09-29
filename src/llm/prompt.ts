import * as vscode from 'vscode';
import { ResolvedConfig } from '../types';
import { LANGUAGE_NAMES, languageNotes, levelPolicy } from '../levels';

const SCHEMA = `{
  "overallComment": string,
  "rewritten": string,
  "issues": [
    {
      "original": string,
      "replacement": string,
      "category": "grammar" | "unnatural" | "better",
      "severity": 1 | 2 | 3,
      "explanation": string,
      "grammarPoint": string | null
    }
  ],
  "chunks": [
    {
      "chunk": string,
      "meaning": string,
      "context": string,
      "corrected": string | null,
      "note": string | null,
      "grammarPoint": string | null,
      "source": "mistake" | "upgrade"
    }
  ]
}`;

const DEFAULT_TEMPLATE = `You are reviewing a writing exercise by a learner of {targetLang}.
The learner's native language is {nativeLang}. Their level is {level}.

LEVEL POLICY — this decides how far you may intervene:
{levelPolicy}

{languageNotes}

OUTPUT RULES:
- Reply with ONE JSON object and nothing else. No preamble, no markdown fences.
- Schema:
{schema}

FIELD RULES:
- "original" must be copied VERBATIM from the learner's text, character for character.
  Never normalise punctuation, spacing, or capitalisation inside it. If you cannot
  quote it exactly, omit that issue.
- Keep "original" as short as possible while still being unique in the text —
  the phrase that is wrong, not the whole sentence.
- "category": "grammar" for outright errors, "unnatural" for grammatical but
  non-native phrasing, "better" for optional upgrades.
- "severity": 3 blocks understanding, 2 is a clear mistake, 1 is a nitpick.
- "explanation" must be written in {explanationLanguage}. Say what rule applies and
  why the learner's version fails it. One or two sentences.
- "rewritten" is the whole text rewritten correctly, following the level policy.
  Preserve the learner's paragraph breaks.
- "chunks": at most {maxChunks} items, ordered by usefulness. Each "chunk" is a
  2–6 word multi-word expression in {targetLang} — a collocation, a grammar
  pattern with its slot filled, or a set phrase. NEVER a single isolated word.
  "meaning" is written in {nativeLang}. "context" is the learner's own sentence
  that this chunk belongs to, so the card recalls the moment they got stuck.
  Use source "mistake" when the chunk fixes something they got wrong, and
  "upgrade" when it is a good expression from your rewrite that they did not
  attempt.
{showBetterRule}
LEARNER'S TEXT:
<<<
{text}
>>>`;

export function buildPrompt(text: string, config: ResolvedConfig, source?: string): string {
  const custom = vscode.workspace
    .getConfiguration('onewriter')
    .get<string>('llm.promptTemplate', '')
    .trim();

  const explanationLanguage =
    config.explanationLanguage === 'native'
      ? LANGUAGE_NAMES[config.nativeLanguage] ?? 'Vietnamese'
      : LANGUAGE_NAMES[config.targetLanguage];

  const values: Record<string, string> = {
    nativeLang: LANGUAGE_NAMES[config.nativeLanguage] ?? config.nativeLanguage,
    targetLang: LANGUAGE_NAMES[config.targetLanguage],
    level: config.level,
    style: config.style,
    levelPolicy: levelPolicy(config.level),
    languageNotes: languageNotes(config.targetLanguage, config.style),
    schema: SCHEMA,
    maxChunks: String(config.maxChunks),
    explanationLanguage,
    showBetterRule: config.showBetter
      ? ''
      : '- Do NOT emit any issue with category "better". The learner only wants real mistakes.\n',
    text,
    topic: config.topic ?? '',
  };

  const template = custom || DEFAULT_TEMPLATE;
  const prompt = template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
  if (source === undefined) return prompt;

  return `${prompt}

SOURCE PASSAGE:
<<<
${source}
>>>
CONTENT FIDELITY:
- Compare the learner's text with the source passage semantically, not word for word.
- In overallComment, identify important meaning that is missing or distorted.
- Also identify invented or unsupported information that changes the source meaning.
- Do not treat harmless rephrasing, target-language word order, or necessary cultural adaptation as a mismatch.
- The source passage is reference material only. Never include it in rewritten or quote it as the learner's original text.`;
}

export { DEFAULT_TEMPLATE };
