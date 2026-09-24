const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

class CancellationError extends Error {}
const configuration = new Map();
const logs = [];
const vscode = {
  CancellationError,
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => configuration.has(key) ? configuration.get(key) : fallback }),
  },
  env: { language: 'en' },
  window: { createOutputChannel: () => ({ info: (line) => logs.push(line) }) },
};

const originalFetch = global.fetch;
test.afterEach(() => {
  global.fetch = originalFetch;
  configuration.clear();
  logs.length = 0;
});

function token() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function response(data) {
  return new Response(JSON.stringify(data), { status: 200 });
}

const format = {
  name: 'onewriter_chunks',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array' } },
  },
};

for (const [providerName, source, className] of [
  ['Gemini', 'src/llm/providers/gemini.ts', 'GeminiProvider'],
  ['OpenAI', 'src/llm/providers/openai.ts', 'OpenAIProvider'],
  ['Qwen', 'src/llm/providers/qwen.ts', 'QwenProvider'],
  ['DeepSeek', 'src/llm/providers/deepseek.ts', 'DeepSeekProvider'],
  ['Claude', 'src/llm/providers/claude.ts', 'ClaudeProvider'],
]) {
  test(`${providerName} redacts an arbitrary API key used as a model after a malformed success`, async () => {
    const Provider = loadTs(source, { vscode })[className];
    const apiKey = `arbitrary-${providerName.toLowerCase()}-credential`;
    let request;
    global.fetch = async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return response({});
    };

    await assert.rejects(new Provider(apiKey, apiKey).complete('review', token()), (error) => {
      for (const exposed of [error.message, error.stack, JSON.stringify(error), logs.join('\n')]) {
        assert.doesNotMatch(exposed, new RegExp(apiKey));
      }
      return true;
    });

    if (providerName === 'Gemini') {
      assert.match(request.url, new RegExp(encodeURIComponent(apiKey)));
    } else {
      assert.equal(request.body.model, apiKey);
    }
  });
}

test('Gemini sends its native JSON-schema request and returns text parts', async () => {
  const { GeminiProvider } = loadTs('src/llm/providers/gemini.ts', { vscode });
  const { REVIEW_JSON_SCHEMA } = loadTs('src/llm/schema.ts');
  let request;
  global.fetch = async (url, init) => {
    request = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return response({ candidates: [{ content: { parts: [{ text: '{"issues":[]}' }] } }] });
  };

  const provider = new GeminiProvider('gemini-secret', 'gemini-3.8-flash');
  assert.equal(await provider.complete('review this', token()), '{"issues":[]}');
  assert.equal(provider.name, 'gemini');
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(request.headers.get('x-goog-api-key'), 'gemini-secret');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(request.body.generationConfig.responseJsonSchema, REVIEW_JSON_SCHEMA);
  assert.equal(request.body.generationConfig.maxOutputTokens, 8192);
});

test('Gemini sends a caller-supplied JSON schema', async () => {
  const { GeminiProvider } = loadTs('src/llm/providers/gemini.ts', { vscode });
  let request;
  global.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return response({ candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] });
  };

  await new GeminiProvider('gemini-secret', 'gemini-model').complete('enrich', token(), format);
  assert.deepEqual(request.generationConfig.responseJsonSchema, format.schema);
});

test('Gemini returns only the first usable candidate and joins its text parts', async () => {
  const { GeminiProvider } = loadTs('src/llm/providers/gemini.ts', { vscode });
  global.fetch = async () => response({ candidates: [
    { content: { parts: [{ text: '{"issues":' }, { inlineData: {} }, null, { text: '[]}' }] } },
    { content: { parts: [{ text: '{"issues":[],"rewritten":"second candidate"}' }] } },
  ] });
  assert.equal(await new GeminiProvider('gemini-secret', 'gemini-model').complete('review', token()), '{"issues":[]}');
});

for (const [description, firstCandidate] of [
  ['null', null],
  ['malformed parts', { content: { parts: {} } }],
  ['non-text parts', { content: { parts: [{ inlineData: {} }, { text: 123 }] } }],
  ['empty text', { content: { parts: [{ text: '' }] } }],
  ['whitespace text', { content: { parts: [{ text: ' \n\t' }] } }],
]) {
  test(`Gemini skips a first candidate with ${description} and returns the next usable candidate`, async () => {
    const { GeminiProvider } = loadTs('src/llm/providers/gemini.ts', { vscode });
    global.fetch = async () => response({ candidates: [
      firstCandidate,
      { content: { parts: [{ text: '{"issues":' }, { text: '[]}' }] } },
    ] });
    assert.equal(await new GeminiProvider('gemini-secret', 'gemini-model').complete('review', token()), '{"issues":[]}');
  });
}

for (const [name, data] of [
  ['blocked response', { promptFeedback: { blockReason: 'SAFETY' } }],
  ['response without candidates', { candidates: [] }],
  ['candidate without text', { candidates: [{ content: { parts: [{ inlineData: {} }] } }] }],
]) {
  test(`Gemini rejects ${name} as a provider-tagged response-format error`, async () => {
    const { GeminiProvider } = loadTs('src/llm/providers/gemini.ts', { vscode });
    global.fetch = async () => response(data);

    await assert.rejects(new GeminiProvider('gemini-secret', 'gemini-model').complete('review', token()), (error) => {
      assert.equal(error.name, 'LLMError');
      assert.equal(error.kind, 'parse');
      assert.equal(error.retryable, false);
      assert.equal(error.provider, 'gemini');
      assert.equal(error.model, 'gemini-model');
      return true;
    });
  });
}

test('Qwen uses the configured compatible endpoint and chat-completions request contract', async () => {
  const { QwenProvider } = loadTs('src/llm/providers/qwen.ts', { vscode });
  let request;
  global.fetch = async (url, init) => {
    request = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return response({ choices: [{ message: { content: '{"issues":[]}' } }] });
  };

  const provider = new QwenProvider('qwen-secret', 'qwen3.8-max', 'https://qwen.example.test/v1///');
  assert.equal(await provider.complete('review this', token()), '{"issues":[]}');
  assert.equal(provider.name, 'qwen');
  assert.equal(request.url, 'https://qwen.example.test/v1/chat/completions');
  assert.equal(request.headers.get('authorization'), 'Bearer qwen-secret');
  assert.deepEqual(request.body, {
    model: 'qwen3.8-max',
    messages: [{ role: 'user', content: 'review this' }],
    response_format: { type: 'json_object' },
    max_tokens: 8192,
  });
});

test('Qwen uses its default compatible base URL', async () => {
  const { QwenProvider } = loadTs('src/llm/providers/qwen.ts', { vscode });
  let request;
  global.fetch = async (url) => {
    request = { url };
    return response({ choices: [{ message: { content: '{"issues":[]}' } }] });
  };

  await new QwenProvider('qwen-secret', 'qwen3.8-max').complete('review this', token());
  assert.equal(request.url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
});

for (const baseUrl of [
  'http://qwen.example.test/v1', 'not a URL', '/compatible-mode/v1',
  '//qwen.example.test/v1', 'https://', 'ftp://qwen.example.test/v1',
  '', null, 42, {}, ['https://qwen.example.test/v1'],
]) {
  test(`Qwen rejects unsafe or invalid base URL ${JSON.stringify(baseUrl)} before fetch`, async () => {
    const { QwenProvider } = loadTs('src/llm/providers/qwen.ts', { vscode });
    let requests = 0;
    global.fetch = async () => { requests++; return response({ choices: [{ message: { content: 'ok' } }] }); };
    await assert.rejects(async () => new QwenProvider('qwen-secret', 'qwen-model', baseUrl)
      .complete('private essay', token()), (error) => {
      assert.equal(error.name, 'LLMError');
      assert.equal(error.kind, 'configuration');
      assert.equal(error.provider, 'qwen');
      assert.equal(error.model, 'qwen-model');
      assert.equal(error.retryable, false);
      assert.match(error.message, /onewriter\.llm\.qwen\.baseUrl/);
      assert.match(error.message, /HTTPS/);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /qwen-secret|private essay/);
      return true;
    });
    assert.equal(requests, 0);
  });
}

for (const [locale, action] of [['en', /Set /], ['vi', /Đặt /], ['ja', /設定してください/]]) {
  test(`Qwen URL error is actionable in ${locale} and exposes no configured credential`, async () => {
    configuration.set('uiLanguage', locale);
    const { QwenProvider } = loadTs('src/llm/providers/qwen.ts', { vscode });
    let requests = 0;
    global.fetch = async () => { requests++; return response({ choices: [{ message: { content: 'ok' } }] }); };
    const secret = 'arbitrary-qwen-credential';
    await assert.rejects(async () => new QwenProvider(secret, `custom-${secret}`, `http://user:${secret}@qwen.example.test/v1`)
      .complete('private essay', token()), (error) => {
      assert.equal(error.model, 'custom-[REDACTED]');
      assert.match(error.message, action);
      assert.match(error.message, /onewriter\.llm\.qwen\.baseUrl/);
      assert.match(error.message, /HTTPS/);
      for (const exposed of [error.message, error.stack, JSON.stringify(error), logs.join('\n')]) {
        assert.doesNotMatch(exposed, /arbitrary-qwen-credential|user:|qwen\.example\.test|private essay/);
      }
      return true;
    });
    assert.equal(requests, 0);
  });
}

test('DeepSeek uses its native compatible endpoint and joins text content parts', async () => {
  const { DeepSeekProvider } = loadTs('src/llm/providers/deepseek.ts', { vscode });
  let request;
  global.fetch = async (url, init) => {
    request = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return response({ choices: [{ message: { content: [
      { type: 'text', text: '{"issues":' }, { type: 'text', text: '[]}' },
    ] } }] });
  };

  const provider = new DeepSeekProvider('deepseek-secret', 'deepseek-v4-flash');
  assert.equal(await provider.complete('review this', token()), '{"issues":[]}');
  assert.equal(provider.name, 'deepseek');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.get('authorization'), 'Bearer deepseek-secret');
  assert.deepEqual(request.body, {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'review this' }],
    response_format: { type: 'json_object' },
    max_tokens: 8192,
  });
});

for (const [providerName, source, className] of [
  ['Qwen', 'src/llm/providers/qwen.ts', 'QwenProvider'],
  ['DeepSeek', 'src/llm/providers/deepseek.ts', 'DeepSeekProvider'],
]) {
  test(`${providerName} retains JSON-object mode for a caller-supplied format`, async () => {
    const Provider = loadTs(source, { vscode })[className];
    let request;
    global.fetch = async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ choices: [{ message: { content: '{"items":[]}' } }] });
    };

    await new Provider(`${providerName}-secret`, `${providerName}-model`).complete('enrich', token(), format);
    assert.deepEqual(request.response_format, { type: 'json_object' });
  });
}

for (const [providerName, source, className] of [
  ['Qwen', 'src/llm/providers/qwen.ts', 'QwenProvider'],
  ['DeepSeek', 'src/llm/providers/deepseek.ts', 'DeepSeekProvider'],
]) {
  for (const [name, data] of [
    ['a null root', null],
    ['a non-array choices field', { choices: {} }],
    ['a null choice entry', { choices: [null] }],
    ['a null message entry', { choices: [{ message: null }] }],
    ['missing content', { choices: [{ message: {} }] }],
    ['a content array without text', { choices: [{ message: { content: [{ type: 'image_url' }] } }] }],
  ]) {
    test(`${providerName} rejects ${name} as a provider-tagged response-format error`, async () => {
      const Provider = loadTs(source, { vscode })[className];
      global.fetch = async () => response(data);

      await assert.rejects(new Provider(`${providerName}-secret`, `${providerName}-model`)
        .complete('review', token()), (error) => {
        assert.equal(error.name, 'LLMError');
        assert.equal(error.kind, 'parse');
        assert.equal(error.retryable, false);
        assert.equal(error.provider, providerName.toLowerCase());
        assert.equal(error.model, `${providerName}-model`);
        return true;
      });
    });
  }
}

for (const [name, data] of [
  ['a null root', null],
  ['a non-array candidates field', { candidates: {} }],
  ['a null candidate entry', { candidates: [null] }],
  ['a null content entry', { candidates: [{ content: null }] }],
  ['a non-array parts field', { candidates: [{ content: { parts: {} } }] }],
  ['a null text-part entry', { candidates: [{ content: { parts: [null] } }] }],
]) {
  test(`Gemini rejects ${name} as a tagged response-format error`, async () => {
    const { GeminiProvider } = loadTs('src/llm/providers/gemini.ts', { vscode });
    global.fetch = async () => response(data);

    await assert.rejects(new GeminiProvider('gemini-secret', 'gemini-model').complete('review', token()), (error) => {
      assert.equal(error.name, 'LLMError');
      assert.equal(error.kind, 'parse');
      assert.equal(error.retryable, false);
      assert.equal(error.provider, 'gemini');
      assert.equal(error.model, 'gemini-model');
      return true;
    });
  });
}

test('OpenAI sends its native strict JSON-schema request and concatenates output text', async () => {
  const { OpenAIProvider } = loadTs('src/llm/providers/openai.ts', { vscode });
  const { REVIEW_JSON_SCHEMA } = loadTs('src/llm/schema.ts');
  let request;
  global.fetch = async (url, init) => {
    request = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return response({
      output: [
        { content: [{ type: 'output_text', text: '{"issues":' }, { type: 'reasoning', text: 'ignore' }] },
        { content: [{ type: 'output_text', text: '[]}' }] },
      ],
    });
  };

  const provider = new OpenAIProvider('openai-secret', 'gpt-5.6-luna');
  assert.equal(await provider.complete('review this', token()), '{"issues":[]}');
  assert.equal(provider.name, 'openai');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.get('authorization'), 'Bearer openai-secret');
  assert.equal(request.headers.get('content-type'), 'application/json');
  assert.equal(request.body.model, 'gpt-5.6-luna');
  assert.equal(request.body.input, 'review this');
  assert.equal(request.body.max_output_tokens, 8192);
  assert.deepEqual(request.body.text.format, {
    type: 'json_schema',
    name: 'onewriter_review',
    strict: true,
    schema: REVIEW_JSON_SCHEMA,
  });
});

test('OpenAI sends a caller-supplied JSON schema and name', async () => {
  const { OpenAIProvider } = loadTs('src/llm/providers/openai.ts', { vscode });
  let request;
  global.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return response({ output: [{ content: [{ type: 'output_text', text: '{"items":[]}' }] }] });
  };

  await new OpenAIProvider('openai-secret', 'openai-model').complete('enrich', token(), format);
  assert.equal(request.text.format.name, format.name);
  assert.deepEqual(request.text.format.schema, format.schema);
});

test('OpenAI rejects a response without output text as a provider-tagged response-format error', async () => {
  const { OpenAIProvider } = loadTs('src/llm/providers/openai.ts', { vscode });
  global.fetch = async () => response({ output: [{ content: [{ type: 'reasoning' }] }] });

  await assert.rejects(new OpenAIProvider('openai-secret', 'openai-model').complete('review', token()), (error) => {
    assert.equal(error.name, 'LLMError');
    assert.equal(error.kind, 'parse');
    assert.equal(error.retryable, false);
    assert.equal(error.provider, 'openai');
    assert.equal(error.model, 'openai-model');
    return true;
  });
});

for (const [name, data] of [
  ['a null root', null],
  ['a non-array output field', { output: {} }],
  ['a null output entry', { output: [null] }],
  ['a null content field', { output: [{ content: null }] }],
  ['a non-array content field', { output: [{ content: {} }] }],
  ['a null content entry', { output: [{ content: [null] }] }],
]) {
  test(`OpenAI rejects ${name} as a tagged response-format error`, async () => {
    const { OpenAIProvider } = loadTs('src/llm/providers/openai.ts', { vscode });
    global.fetch = async () => response(data);

    await assert.rejects(new OpenAIProvider('openai-secret', 'openai-model').complete('review', token()), (error) => {
      assert.equal(error.name, 'LLMError');
      assert.equal(error.kind, 'parse');
      assert.equal(error.retryable, false);
      assert.equal(error.provider, 'openai');
      assert.equal(error.model, 'openai-model');
      return true;
    });
  });
}

test('Claude sends its native JSON-schema request and concatenates text blocks', async () => {
  const { ClaudeProvider } = loadTs('src/llm/providers/claude.ts', { vscode });
  const { REVIEW_JSON_SCHEMA } = loadTs('src/llm/schema.ts');
  const prompt = 'review this';
  let request;
  global.fetch = async (url, init) => {
    request = { url, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
    return response({ content: [
      { type: 'text', text: '{"issues":' },
      { type: 'thinking', thinking: 'ignore' },
      { type: 'text', text: '[]}' },
    ] });
  };

  const provider = new ClaudeProvider('claude-secret', 'claude-sonnet-4-6');
  assert.equal(await provider.complete(prompt, token()), '{"issues":[]}');
  assert.equal(provider.name, 'claude');
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'claude-secret');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['anthropic-beta'], undefined);
  assert.equal(request.body.model, 'claude-sonnet-4-6');
  assert.equal(request.body.max_tokens, 8192);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: prompt }]);
  assert.equal(request.body.messages.some((message) => message.role === 'assistant'), false);
  assert.deepEqual(request.body.output_config, {
    format: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA },
  });
});

test('Claude sends a caller-supplied JSON schema', async () => {
  const { ClaudeProvider } = loadTs('src/llm/providers/claude.ts', { vscode });
  let request;
  global.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return response({ content: [{ type: 'text', text: '{"items":[]}' }] });
  };

  await new ClaudeProvider('claude-secret', 'claude-model').complete('enrich', token(), format);
  assert.deepEqual(request.output_config.format.schema, format.schema);
});

for (const [name, data] of [
  ['a null root', null],
  ['a non-array content field', { content: {} }],
  ['a null content entry', { content: [null] }],
  ['content without text blocks', { content: [{ type: 'thinking', thinking: 'ignore' }] }],
  ['a text block without text', { content: [{ type: 'text' }] }],
]) {
  test(`Claude rejects ${name} as a provider-tagged response-format error`, async () => {
    const { ClaudeProvider } = loadTs('src/llm/providers/claude.ts', { vscode });
    global.fetch = async () => response(data);

    await assert.rejects(new ClaudeProvider('claude-secret', 'claude-model').complete('review', token()), (error) => {
      assert.equal(error.name, 'LLMError');
      assert.equal(error.kind, 'parse');
      assert.equal(error.retryable, false);
      assert.equal(error.provider, 'claude');
      assert.equal(error.model, 'claude-model');
      return true;
    });
  });
}
