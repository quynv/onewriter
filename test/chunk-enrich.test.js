const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const { CHUNK_OUTPUT_FORMAT } = loadTs('src/chunks/schema.ts');
const {
  buildChunkPrompt,
  normaliseChunkEnrichment,
  requestChunkEnrichment,
} = loadTs('src/chunks/enrich.ts');

function queueItem(overrides = {}) {
  return {
    id: 'first',
    uri: 'file:///practice.md',
    chunk: 'look forward to',
    normalizedChunk: 'look forward to',
    context: 'I look forward to Friday.',
    targetLanguage: 'en',
    nativeLanguage: 'vi',
    level: 'B1',
    style: 'plain',
    source: 'selection',
    addedAt: 1,
    ...overrides,
  };
}

test('defines a closed structured output schema for chunk enrichment', () => {
  const schema = CHUNK_OUTPUT_FORMAT.schema;
  const item = schema.properties.items.items;

  assert.equal(CHUNK_OUTPUT_FORMAT.name, 'onewriter_chunks');
  assert.deepEqual(schema.required, ['items']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(item.required, ['id', 'meaning', 'example', 'note']);
  assert.deepEqual(Object.keys(item.properties), ['id', 'meaning', 'example', 'note']);
  assert.equal(item.additionalProperties, false);
});

test('builds a bounded prompt from chunks, contexts, and the shared language tuple', () => {
  const prompt = buildChunkPrompt([
    queueItem(),
    queueItem({
      id: 'second',
      chunk: 'take part in',
      context: 'We take part in the event.',
    }),
  ]);

  assert.match(prompt, /"id":"first"/);
  assert.match(prompt, /"chunk":"look forward to"/);
  assert.match(prompt, /"context":"I look forward to Friday\."/);
  assert.match(prompt, /"id":"second"/);
  assert.match(prompt, /"chunk":"take part in"/);
  assert.match(prompt, /"context":"We take part in the event\."/);
  assert.match(prompt, /nativeLanguage \(vi\)/);
  assert.match(prompt, /targetLanguage \(en\)/);
  assert.match(prompt, /B1/);
  assert.match(prompt, /plain/);
  assert.doesNotMatch(prompt, /ENTIRE UNRELATED DOCUMENT SENTINEL/);
});

test('normalizes only the first valid result for each requested ID in request order', () => {
  const result = normaliseChunkEnrichment({
    items: [
      { id: 'second', meaning: '  tham gia  ', example: '  We take part.  ', note: '  common  ' },
      { id: 'unknown', meaning: 'ignored', example: 'Ignored.', note: null },
      { id: 'second', meaning: 'duplicate', example: 'Duplicate.', note: null },
      { id: 'first', meaning: '   ', example: 'Missing meaning.', note: null },
      { id: 'first', meaning: 'mong đợi', example: 42, note: null },
      { id: ' first ', meaning: '  mong đợi  ', example: '  I look forward to it.  ', note: '   ' },
      { id: 'third', meaning: '', example: 'Missing.', note: null },
    ],
  }, new Set(['first', 'second', 'third']));

  assert.deepEqual(result.enriched, [
    { id: 'first', meaning: 'mong đợi', example: 'I look forward to it.', note: undefined },
    { id: 'second', meaning: 'tham gia', example: 'We take part.', note: 'common' },
  ]);
  assert.deepEqual(result.failedIds, ['third']);
});

test('uses the chunk schema for one provider call and rejects an empty batch', async () => {
  const calls = [];
  const llm = {
    name: 'gemini',
    complete: async (prompt, token, format) => {
      calls.push({ prompt, token, format });
      return '{"items":[{"id":"first","meaning":"mong đợi","example":"I look forward to it.","note":null}]}';
    },
  };
  const token = { isCancellationRequested: false };

  assert.deepEqual(await requestChunkEnrichment(llm, [queueItem()], token), {
    enriched: [{ id: 'first', meaning: 'mong đợi', example: 'I look forward to it.', note: undefined }],
    failedIds: [],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].format, CHUNK_OUTPUT_FORMAT);
  await assert.rejects(requestChunkEnrichment(llm, [], token), /at least one queued chunk/i);
  assert.equal(calls.length, 1);
});

for (const [name, className] of [['qwen', 'QwenProvider'], ['deepseek', 'DeepSeekProvider']]) {
  test(`${name} serialized request states the complete chunk JSON contract without a transmitted schema`, async (t) => {
    const vscode = {
      CancellationError: class extends Error {},
      window: { createOutputChannel: () => ({ info() {} }) },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    };
    const Provider = loadTs(`src/llm/providers/${name}.ts`, { vscode })[className];
    let request;
    t.mock.method(global, 'fetch', async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content:
        '{"items":[{"id":"first","meaning":"mong đợi","example":"I look forward to your visit.","note":null}]}' } }] }));
    });
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const result = await requestChunkEnrichment(new Provider('synthetic-key', 'synthetic-model'), [queueItem()], token);
    assert.equal(result.enriched[0].id, 'first');
    assert.deepEqual(request.response_format, { type: 'json_object' });
    const prompt = request.messages[0].content;
    assert.match(prompt, /\{"items":\[\{"id":"[^"]+","meaning":"[^"]+","example":"[^"]+","note":null\}\]\}/);
    assert.match(prompt, /one (?:output )?item per input/i);
    assert.match(prompt, /copy (?:each )?id exactly/i);
    assert.match(prompt, /new natural (?:sentence|example).*targetLanguage/i);
    assert.match(prompt, /optional short usage or grammar note/i);
    assert.match(prompt, /note.*string or null/i);
    assert.match(prompt, /raw JSON.*(?:only|without)/i);
  });
}
