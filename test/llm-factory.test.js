const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');
const properties = require('../package.json').contributes.configuration.properties;

class CancellationError extends Error {}
class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
const settings = new Map();
const workspaceSettings = new Map();
const folderSettings = new Map();
const secrets = new Map();
const warnings = [], inputs = [], commands = [], errors = [], logs = [], states = [];
let warningAnswer, inputAnswer, errorAnswer;
const vscode = {
  EventEmitter,
  CancellationError,
  ProgressLocation: { Notification: 1 },
  env: { language: 'en' },
  workspace: { getConfiguration: (_section, resource) => ({
    get: (key, fallback) => {
      const folder = resource && [...folderSettings.keys()]
        .find((path) => resource.path.startsWith(`${path}/`));
      const scoped = properties[`onewriter.${key}`]?.scope === 'resource'
        ? folderSettings.get(folder) : undefined;
      return scoped?.has(key) ? scoped.get(key)
        : workspaceSettings.has(key) ? workspaceSettings.get(key)
          : settings.has(key) ? settings.get(key) : fallback;
    },
    update: () => assert.fail('factory/error recovery must not change settings'),
  }) },
  window: {
    showWarningMessage: async (...args) => { warnings.push(args); return warningAnswer; },
    showInputBox: async (options) => { inputs.push(options); return inputAnswer; },
    showQuickPick: () => assert.fail('selected provider must be passed to key flow'),
    showInformationMessage() {},
    showErrorMessage: async (...args) => { errors.push(args); return errorAnswer; },
    createOutputChannel: () => ({ info: (line) => logs.push(line), error: (line) => logs.push(line), show: () => commands.push(['output']) }),
  },
  commands: { executeCommand: async (...args) => commands.push(args) },
};
const context = {
  secrets: { get: async (key) => secrets.get(key), store: async (key, value) => secrets.set(key, value) },
  workspaceState: { get: () => undefined, update: async () => {} },
};
const { ChunkQueueStore } = loadTs('src/chunks/store.ts', { vscode });
const chunkQueue = new ChunkQueueStore(context.workspaceState);
const errorModule = loadTs('src/llm/errors.ts', { vscode });
const mocks = { vscode, './errors': errorModule, '../errors': errorModule, '../llm/errors': errorModule };
const { LLMError } = errorModule;
const { createProvider, requestReview } = loadTs('src/llm/provider.ts', mocks);
const { REVIEW_JSON_SCHEMA } = loadTs('src/llm/schema.ts');
const { ReviewController } = loadTs('src/review/controller.ts', mocks);
const { reportLlmError } = loadTs('src/llm/report.ts', mocks);
const { SidebarProvider } = loadTs('src/ui/sidebar.ts', { vscode });
const { extractJsonObject } = loadTs('src/llm/json.ts', mocks);
const originalFetch = global.fetch;
const environmentNames = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY'];
const originalEnvironment = Object.fromEntries(environmentNames.map((key) => [key, process.env[key]]));
test.beforeEach(() => {
  settings.clear(); workspaceSettings.clear(); folderSettings.clear(); secrets.clear();
  vscode.window.activeTextEditor = undefined;
  for (const list of [warnings, inputs, commands, errors, logs, states]) list.length = 0;
  warningAnswer = inputAnswer = errorAnswer = undefined;
  for (const key of environmentNames) delete process.env[key];
});
test.afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const config = { nativeLanguage: 'en', targetLanguage: 'en', level: 'B1', style: 'plain', explanationLanguage: 'native', showBetter: true, maxChunks: 8, reviewMode: 'codelens' };

function successfulResponse() {
  const text = '{"issues":[],"rewritten":"corrected"}';
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    choices: [{ message: { content: text } }],
    content: [{ type: 'text', text }],
  }));
}

for (const provider of ['gemini', 'openai', 'qwen', 'deepseek', 'claude']) {
  test(`resource-selected ${provider} sends its folder model and credentials`, async () => {
    settings.set('llm.provider', 'gemini');
    secrets.set('onewriter.apiKey.gemini', 'global-secret');
    secrets.set(`onewriter.apiKey.${provider}`, `${provider}-folder-secret`);
    folderSettings.set('/workspace/a', new Map([
      ['llm.provider', provider], [`llm.${provider}.model`, `${provider}-folder-model`],
      ['llm.qwen.baseUrl', 'https://folder-a.example.test/v1///'],
    ]));
    let request;
    global.fetch = async (url, init) => {
      request = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return successfulResponse();
    };
    const llm = await createProvider(context, { path: '/workspace/a/writing.md' });
    await llm.complete('review', token);
    assert.equal(llm.name, provider);
    if (provider === 'gemini') assert.match(request.url, /models\/gemini-folder-model:generateContent$/);
    else assert.equal(request.body.model, `${provider}-folder-model`);
    if (provider === 'qwen') assert.equal(request.url, 'https://folder-a.example.test/v1/chat/completions');
    assert.ok([...request.headers.values()].some((value) => value.includes(`${provider}-folder-secret`)));
  });
}

test('resource configuration retains workspace and global fallback precedence', async () => {
  settings.set('llm.provider', 'qwen');
  settings.set('llm.qwen.model', 'global-model');
  settings.set('llm.qwen.baseUrl', 'https://global.example.test/v1');
  workspaceSettings.set('llm.qwen.model', 'workspace-model');
  folderSettings.set('/workspace/a', new Map([
    ['llm.qwen.baseUrl', 'https://folder.example.test/v1'],
  ]));
  secrets.set('onewriter.apiKey.qwen', 'secret');
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, model: JSON.parse(init.body).model });
    return successfulResponse();
  };
  await (await createProvider(context, { path: '/workspace/a/writing.md' })).complete('review', token);
  await (await createProvider(context, { path: '/workspace/b/writing.md' })).complete('review', token);
  workspaceSettings.clear();
  await (await createProvider(context)).complete('review', token);
  assert.deepEqual(requests, [
    { url: 'https://folder.example.test/v1/chat/completions', model: 'workspace-model' },
    { url: 'https://global.example.test/v1/chat/completions', model: 'workspace-model' },
    { url: 'https://global.example.test/v1/chat/completions', model: 'global-model' },
  ]);
});

test('review and sidebar follow two active folders including distinct Qwen base URLs', async () => {
  settings.set('llm.provider', 'gemini');
  settings.set('llm.qwen.baseUrl', 'https://global.example.test/v1');
  secrets.set('onewriter.apiKey.gemini', 'global-secret');
  secrets.set('onewriter.apiKey.openai', 'openai-secret');
  secrets.set('onewriter.apiKey.qwen', 'qwen-secret');
  folderSettings.set('/workspace/a', new Map([
    ['llm.provider', 'openai'], ['llm.openai.model', 'openai-folder-a'],
    ['llm.qwen.model', 'qwen-folder-a'], ['llm.qwen.baseUrl', 'https://a.example.test/v1///'],
  ]));
  folderSettings.set('/workspace/b', new Map([
    ['llm.provider', 'qwen'], ['llm.qwen.model', 'qwen-folder-b'],
    ['llm.qwen.baseUrl', 'https://b.example.test/v1/'],
  ]));
  const requests = [], reviewed = [];
  global.fetch = async (url, init) => {
    requests.push({ url, model: JSON.parse(init.body).model });
    return successfulResponse();
  };
  vscode.window.withProgress = async (_options, run) => run({}, token);
  const store = { set: async (uri, session) => { reviewed.push({ uri, session }); }, get: () => undefined };
  const controller = new ReviewController(context, store, {}, {}, chunkQueue);
  const sidebar = new SidebarProvider({}, store, chunkQueue);
  sidebar.view = { webview: { postMessage: (state) => states.push(state) } };
  for (const folder of ['a', 'b', 'a']) {
    if (requests.length === 2) folderSettings.get('/workspace/a').set('llm.provider', 'qwen');
    const document = { uri: { path: `/workspace/${folder}/writing.md` }, getText: () => 'This is enough writing to review.' };
    vscode.window.activeTextEditor = { document };
    sidebar.refresh();
    await controller.review(document);
  }
  assert.deepEqual(requests, [
    { url: 'https://api.openai.com/v1/responses', model: 'openai-folder-a' },
    { url: 'https://b.example.test/v1/chat/completions', model: 'qwen-folder-b' },
    { url: 'https://a.example.test/v1/chat/completions', model: 'qwen-folder-a' },
  ]);
  assert.deepEqual(states.map((state) => state.payload.provider), [
    'OpenAI · openai-folder-a', 'Qwen · qwen-folder-b', 'Qwen · qwen-folder-a',
  ]);
  assert.equal(reviewed.length, 3);
  assert.equal(errors.length, 0);
});

test('exhausted review parsing reports the document-folder model with safe metadata', async () => {
  const secret = 'folder-provider-secret';
  settings.set('llm.provider', 'gemini');
  settings.set('llm.qwen.model', 'unrelated-global-model');
  secrets.set('onewriter.apiKey.qwen', secret);
  folderSettings.set('/workspace/a', new Map([
    ['llm.provider', 'qwen'], ['llm.qwen.model', `folder-${secret}-model`],
  ]));
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'invalid review JSON' } }] }));
  };
  vscode.window.withProgress = async (_options, run) => run({}, token);
  await new ReviewController(context, {}, {}, {}, chunkQueue).review({
    uri: { path: '/workspace/a/writing.md' }, getText: () => 'This is enough writing to review.',
  });
  assert.equal(requests, 2);
  assert.match(errors[0][0], /Qwen · folder-\[REDACTED\]-model/);
  assert.doesNotMatch(JSON.stringify({ errors, logs }), /folder-provider-secret|unrelated-global-model/);
});

test('review offers Settings for an invalid folder Qwen URL without sending a request', async () => {
  secrets.set('onewriter.apiKey.qwen', 'qwen-secret');
  folderSettings.set('/workspace/a', new Map([
    ['llm.provider', 'qwen'], ['llm.qwen.model', 'qwen-folder-model'],
    ['llm.qwen.baseUrl', 'http://user:qwen-secret@private.example.test/v1'],
  ]));
  let requests = 0;
  global.fetch = async () => { requests++; return successfulResponse(); };
  vscode.window.withProgress = async (_options, run) => run({}, token);
  errorAnswer = 'Open Settings';
  await new ReviewController(context, { set() {} }, {}, {}, chunkQueue).review({
    uri: { path: '/workspace/a/writing.md' }, getText: () => 'This is enough writing to review.',
  });
  assert.equal(requests, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Qwen · qwen-folder-model/);
  assert.match(errors[0][0], /onewriter\.llm\.qwen\.baseUrl/);
  assert.match(errors[0][0], /HTTPS/);
  assert.deepEqual(errors[0].slice(1), ['Open Settings']);
  assert.deepEqual(commands, [['workbench.action.openSettings', '@ext:onewriter.onewriter']]);
  assert.doesNotMatch(JSON.stringify({ errors, logs }), /qwen-secret|private\.example\.test|user:/);
});

test('Qwen Model not exist. rejection offers Settings without retrying', async () => {
  settings.set('llm.provider', 'qwen');
  settings.set('llm.qwen.model', 'qwen-custom');
  secrets.set('onewriter.apiKey.qwen', 'qwen-secret');
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response('{"error":{"message":"Model not exist."}}', { status: 400 });
  };
  vscode.window.withProgress = async (_options, run) => run({}, token);
  errorAnswer = 'Open Settings';
  await new ReviewController(context, {}, {}, {}, chunkQueue).review({
    uri: { path: '/writing.md' }, getText: () => 'This is enough writing to review.',
  });
  assert.equal(requests, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Qwen · qwen-custom/);
  assert.deepEqual(errors[0].slice(1), ['Open Settings']);
  assert.deepEqual(commands, [['workbench.action.openSettings', '@ext:onewriter.onewriter']]);
});

for (const provider of ['gemini', 'openai', 'qwen', 'deepseek', 'claude']) {
  test(`factory creates ${provider} and requests its own configured model/key`, async () => {
    settings.set('llm.provider', provider);
    settings.set(`llm.${provider}.model`, `${provider}-custom`);
    secrets.set(`onewriter.apiKey.${provider}`, `${provider}-secret`);
    let request;
    global.fetch = async (url, init) => {
      request = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        choices: [{ message: { content: 'ok' } }],
        content: [{ type: 'text', text: 'ok' }],
      }));
    };
    const llm = await createProvider(context);
    assert.equal(llm.name, provider);
    assert.equal(await llm.complete('test', token), 'ok');
    if (provider === 'gemini') assert.match(request.url, /models\/gemini-custom:generateContent$/);
    else assert.equal(request.body.model, `${provider}-custom`);
    assert.ok([...request.headers.values()].some((value) => value.includes(`${provider}-secret`)));
  });
}
for (const value of [undefined, 'invalid', 'cli', 'api']) {
  test(`factory defaults ${value} provider to Gemini`, async () => {
    if (value !== undefined) settings.set('llm.provider', value);
    secrets.set('onewriter.apiKey.gemini', 'secret');
    assert.equal((await createProvider(context)).name, 'gemini');
  });
}
test('missing key offers Set API Key and Cancel for the selected provider', async () => {
  settings.set('llm.provider', 'qwen');
  assert.equal(await createProvider(context), undefined);
  assert.match(warnings[0][0], /Qwen/);
  assert.deepEqual(warnings[0].slice(1), ['Set API Key', 'Cancel']);
});
test('setting a missing key continues with the same provider', async () => {
  settings.set('llm.provider', 'deepseek');
  warningAnswer = 'Set API Key'; inputAnswer = ' deepseek-new-secret ';
  assert.equal((await createProvider(context)).name, 'deepseek');
  assert.match(inputs[0].prompt, /DeepSeek/);
  assert.equal(secrets.get('onewriter.apiKey.deepseek'), 'deepseek-new-secret');
});
test('cancelling key entry returns no provider', async () => {
  settings.set('llm.provider', 'claude'); warningAnswer = 'Set API Key';
  assert.equal(await createProvider(context), undefined);
  assert.equal(inputs.length, 1);
});
test('review explicitly sends the review output format and normalizes on the first call', async () => {
  let calls = 0;
  const formats = [];
  const result = await requestReview({ name: 'gemini', complete: async (_prompt, _token, output) => {
    calls++; formats.push(output); return '{"issues":[],"rewritten":"fixed"}';
  } }, 'text', config, token);
  assert.equal(calls, 1);
  assert.deepEqual(formats, [{ name: 'onewriter_review', schema: REVIEW_JSON_SCHEMA }]);
  assert.deepEqual(result, { issues: [], chunks: [], rewritten: 'fixed', overallComment: '' });
});
test('malformed review JSON retries exactly once with strict suffix', async () => {
  const prompts = [];
  const result = await requestReview({ name: 'gemini', complete: async (prompt) => {
    prompts.push(prompt); return prompts.length === 1 ? 'invalid' : '{"issues":[]}';
  } }, 'text', config, token);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], `${prompts[0]}\n\nYour previous reply could not be parsed. Reply with the raw JSON object only. Start your reply with { and end it with }. No explanation, no code fence.`);
  assert.deepEqual(result.issues, []);
});
for (const kind of ['auth', 'quota', 'model', 'timeout']) {
  test(`${kind} errors do not retry`, async () => {
    const failure = new LLMError('safe failure', false, kind);
    let calls = 0;
    await assert.rejects(requestReview({ name: 'claude', complete: async () => { calls++; throw failure; } }, 'text', config, token), (error) => error === failure);
    assert.equal(calls, 1);
  });
}
test('second malformed response becomes parse error and no response prose reaches logs', async () => {
  let calls = 0;
  await assert.rejects(requestReview({ name: 'openai', complete: async () => { calls++; return 'remote prose secret-123'; } }, 'text', config, token), (error) => error.kind === 'parse');
  assert.equal(calls, 2);
  assert.doesNotMatch(logs.join('\n'), /remote prose|secret-123/);
});
test('unknown completion failure is sanitized and does not retry', async () => {
  let calls = 0;
  await assert.rejects(requestReview({ name: 'openai', complete: async () => { calls++; throw new Error('remote prose secret-123'); } }, 'text', config, token), (error) => {
    assert.doesNotMatch(error.message, /remote prose|secret-123/); return error.kind === 'other';
  });
  assert.equal(calls, 1);
});
test('JSON extraction preserves raw, fenced and prose JSON without interpreting CLI envelopes', () => {
  for (const raw of ['{"issues":[]}', '```json\n{"issues":[]}\n```', 'Answer: {"issues":[]} done']) assert.deepEqual(extractJsonObject(raw), { issues: [] });
  const envelope = { is_error: true, result: '{"issues":[]}' };
  assert.deepEqual(extractJsonObject(JSON.stringify(envelope)), envelope);
});
for (const kind of ['auth', 'model', 'quota', 'timeout', 'network', 'parse', 'other']) {
  test(`review ${kind} recovery is provider-aware and sanitized`, async () => {
    settings.set('llm.provider', 'gemini'); settings.set('llm.timeoutMs', 123000);
    errorAnswer = kind === 'auth' ? 'Set API Key' : kind === 'model' ? 'Open Settings' : 'Open log';
    await reportLlmError(context, new LLMError('remote prose secret-123', false, kind, { provider: 'qwen', model: 'qwen-custom' }), undefined, 'review');
    assert.doesNotMatch(JSON.stringify(errors), /remote prose|secret-123/);
    assert.match(errors[0][0], /Qwen/);
    assert.match(errors[0][0], /qwen-custom/);
    if (kind === 'auth') assert.deepEqual(commands, [['onewriter.setApiKey', 'qwen']]);
    else if (kind === 'model') assert.deepEqual(commands, [['workbench.action.openSettings', '@ext:onewriter.onewriter']]);
    else if (kind === 'timeout') { assert.match(errors[0][0], /123/); assert.match(errors[0][0], /onewriter.llm.timeoutMs/); }
    else if (kind === 'quota') assert.match(errors[0][0], /limit/i);
    else assert.deepEqual(commands, [['output']]);
  });
}
test('sidebar reflects provider/model changes and invalid-provider fallback', () => {
  const sidebar = new SidebarProvider({}, {}, chunkQueue);
  sidebar.view = { webview: { postMessage: (state) => states.push(state) } };
  settings.set('llm.provider', 'claude'); settings.set('llm.claude.model', 'claude-custom');
  sidebar.refresh();
  assert.equal(states.at(-1).payload.provider, 'Claude · claude-custom');
  settings.set('llm.provider', 'openai'); settings.set('llm.openai.model', 'openai-custom');
  sidebar.refresh();
  assert.equal(states.at(-1).payload.provider, 'OpenAI · openai-custom');
  settings.set('llm.provider', 'invalid'); sidebar.refresh();
  assert.equal(states.at(-1).payload.provider, 'Gemini · gemini-3.8-flash');
});

test('review failure output never records error prose or stack', async () => {
  secrets.set('onewriter.apiKey.gemini', 'secret');
  vscode.window.withProgress = async () => { throw new LLMError('remote prose secret-123', false, 'auth', { provider: 'gemini', model: 'configured-model', status: 401 }); };
  const document = { getText: () => 'This is enough writing to review.', uri: { path: '/writing.md' } };
  await new ReviewController(context, {}, {}, {}, chunkQueue).review(document);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(logs.join('\n'), /remote prose|secret-123/);
  assert.match(logs.join('\n'), /auth/);
});

test('registered set-key command forwards provider and preserves picker when omitted', async () => {
  const callbacks = new Map(), received = [];
  class Renderer { refreshContext() {} refresh() {} onDidChange() {} async cleanDeleted() {} }
  const extensionVscode = {
    ...vscode,
    workspace: { ...vscode.workspace, onDidChangeConfiguration() {} },
    window: { ...vscode.window, registerWebviewViewProvider() {}, onDidChangeActiveTextEditor() {} },
    commands: { ...vscode.commands, registerCommand: (name, callback) => callbacks.set(name, callback) },
  };
  const { activate } = loadTs('src/extension.ts', {
    vscode: extensionVscode,
    './llm/secrets': { migrateLegacyLlmConfig: async () => {}, deleteApiKey() {}, promptForApiKey: async (...args) => received.push(args) },
    './review/store': { ReviewStore: Renderer }, './review/inline': { InlineRenderer: Renderer },
    './review/diff': { DiffRenderer: Renderer }, './review/panel': { PanelRenderer: Renderer },
    './ui/sidebar': { SidebarProvider: Renderer },
  });
  const extensionContext = { ...context, subscriptions: [] };
  await activate(extensionContext);
  await callbacks.get('onewriter.setApiKey')('qwen');
  await callbacks.get('onewriter.setApiKey')();
  assert.deepEqual(received, [[extensionContext, 'qwen'], [extensionContext, undefined]]);
});

for (const failure of ['model rejection', 'exhausted review parsing']) {
  test(`review redacts a stored key pasted into the model after ${failure}`, async () => {
    const secret = 'synthetic-provider-secret-8372';
    const rawModel = `custom-${secret}-sk-recognizableKey`;
    settings.set('llm.provider', 'openai');
    settings.set('llm.openai.model', rawModel);
    secrets.set('onewriter.apiKey.openai', secret);
    const requests = [];
    global.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return failure === 'model rejection'
        ? new Response('{"error":{"message":"Unknown model"}}', { status: 404 })
        : new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'invalid review JSON' }] }] }));
    };
    vscode.window.withProgress = async (_options, run) => run({}, token);
    const document = { getText: () => 'This is enough writing to review.', uri: { path: '/writing.md' } };
    await new ReviewController(context, {}, {}, {}, chunkQueue).review(document);
    assert.equal(requests.length, failure === 'model rejection' ? 1 : 2);
    for (const request of requests) assert.equal(request.model, rawModel);
    assert.equal(errors.length, 1);
    assert.ok(!JSON.stringify({ errors, logs }).includes(secret));
    assert.doesNotMatch(JSON.stringify({ errors, logs }), /sk-recognizableKey/);
    assert.ok(errors[0][0].includes('[REDACTED]'));
  });
}

for (const [scenario, response, expectedCalls, expectedMessage] of [
  ['malformed adapter envelope', { output: [] }, 1, 'The API returned an invalid JSON response.'],
  ['malformed HTTP JSON', 'not JSON', 1, 'The API returned an invalid JSON response.'],
  ['exhausted review JSON', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not review JSON' }] }] }, 2, 'The model did not return valid JSON after 2 tries.'],
]) {
  test(`review reports accurate attempts for ${scenario}`, async () => {
    settings.set('llm.provider', 'openai');
    secrets.set('onewriter.apiKey.openai', 'synthetic-secret');
    let requests = 0;
    global.fetch = async () => {
      requests++;
      return new Response(typeof response === 'string' ? response : JSON.stringify(response));
    };
    vscode.window.withProgress = async (_options, run) => run({}, token);
    const document = { getText: () => 'This is enough writing to review.', uri: { path: '/writing.md' } };
    await new ReviewController(context, {}, {}, {}, chunkQueue).review(document);
    assert.equal(requests, expectedCalls);
    assert.equal(errors.length, 1);
    assert.ok(errors[0][0].includes(expectedMessage), errors[0][0]);
    if (expectedCalls === 1) assert.doesNotMatch(errors[0][0], /2 tries/);
  });
}
