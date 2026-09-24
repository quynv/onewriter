const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const {
  LLM_PROVIDER_IDS,
  PROVIDERS,
} = loadTs('src/llm/providers/types.ts');
const { REVIEW_JSON_SCHEMA, REVIEW_OUTPUT_FORMAT } = loadTs('src/llm/schema.ts');

test('provider definitions are complete and Gemini is the default', () => {
  assert.deepEqual(LLM_PROVIDER_IDS, ['gemini', 'openai', 'qwen', 'deepseek', 'claude']);
  assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-3.8-flash');
  assert.equal(PROVIDERS.gemini.secretId, 'onewriter.apiKey.gemini');
  assert.equal(PROVIDERS.qwen.environmentVariable, 'DASHSCOPE_API_KEY');
  assert.equal(PROVIDERS.claude.secretId, 'onewriter.apiKey.claude');
});

test('review schema requires the normalized result shape', () => {
  assert.deepEqual(REVIEW_JSON_SCHEMA.required, [
    'overallComment',
    'rewritten',
    'issues',
    'chunks',
  ]);
  assert.equal(REVIEW_JSON_SCHEMA.additionalProperties, false);
  assert.equal(REVIEW_JSON_SCHEMA.properties.issues.type, 'array');
});

test('review output format names and wraps the normalized result schema', () => {
  assert.deepEqual(REVIEW_OUTPUT_FORMAT, {
    name: 'onewriter_review',
    schema: REVIEW_JSON_SCHEMA,
  });
});
