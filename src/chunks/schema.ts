import type { LLMOutputFormat } from '../types';

export const CHUNK_OUTPUT_FORMAT: LLMOutputFormat = {
  name: 'onewriter_chunks',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'meaning', 'example', 'note'],
          properties: {
            id: { type: 'string' },
            meaning: { type: 'string' },
            example: { type: 'string' },
            note: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};
