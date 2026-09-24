import type { LLMOutputFormat } from '../types';

export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallComment', 'rewritten', 'issues', 'chunks'],
  properties: {
    overallComment: { type: 'string' },
    rewritten: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'original',
          'replacement',
          'category',
          'severity',
          'explanation',
          'grammarPoint',
        ],
        properties: {
          original: { type: 'string' },
          replacement: { type: 'string' },
          category: { type: 'string', enum: ['grammar', 'unnatural', 'better'] },
          severity: { type: 'integer', enum: [1, 2, 3] },
          explanation: { type: 'string' },
          grammarPoint: { type: ['string', 'null'] },
        },
      },
    },
    chunks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chunk', 'meaning', 'context', 'corrected', 'note', 'grammarPoint', 'source'],
        properties: {
          chunk: { type: 'string' },
          meaning: { type: 'string' },
          context: { type: 'string' },
          corrected: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
          grammarPoint: { type: ['string', 'null'] },
          source: { type: 'string', enum: ['mistake', 'upgrade'] },
        },
      },
    },
  },
} as const;

export const REVIEW_OUTPUT_FORMAT: LLMOutputFormat = {
  name: 'onewriter_review',
  schema: REVIEW_JSON_SCHEMA,
};
