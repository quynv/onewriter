const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const disposable = () => ({ dispose() {} });
class EventEmitter {
  listeners = [];
  event = (listener) => { this.listeners.push(listener); return disposable(); };
  fire(value) { this.listeners.forEach((listener) => listener(value)); }
  dispose() { this.listeners = []; }
}
function uri(value) {
  const parsed = new URL(value);
  return {
    scheme: value.split(':')[0], path: parsed.pathname, query: parsed.search.slice(1), toString: () => value,
    with: (changes) => uri(`${changes.scheme ?? value.split(':')[0]}://${parsed.host}${parsed.pathname}${changes.query ? `?${changes.query}` : ''}`),
  };
}
function document(text = 'We look forward to your reply.', value = 'file:///writing.md', start = 3, end = 18) {
  const offsets = [];
  let content = text;
  const document = {
    uri: uri(value), getText: () => content,
    offsetAt: (position) => { offsets.push(position); return position.offset; },
    positionAt: (offset) => ({ offset }), version: 1,
  };
  return {
    document,
    selection: { start: { offset: start }, end: { offset: end } }, offsets,
    edit: async (callback) => {
      callback({ replace: (range, replacement) => {
        content = content.slice(0, range.start.offset) + replacement + content.slice(range.end.offset);
        document.version++;
      } });
      return true;
    },
  };
}
function setup(options = {}) {
  const callbacks = new Map(), messages = [], logs = [], writes = [], stats = [], renders = [], states = [], reviews = [], sourcePrompts = [];
  const configurationListeners = [], sidebarHtml = [];
  const settings = { uiLanguage: options.locale ?? 'en', nativeLanguage: 'vi', 'review.mode': 'webview' };
  const stateValues = new Map();
  if (options.persisted !== undefined) stateValues.set('onewriter.chunkQueue.v1', options.persisted);
  if (options.reviewPersisted !== undefined) stateValues.set('onewriter.reviewSessions.v1', options.reviewPersisted);
  let answer, sidebarProvider, write = async () => {}, stat = async () => ({});
  const vscode = {
    EventEmitter, CancellationError: class extends Error {}, ProgressLocation: { Notification: 1 },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 }, ViewColumn: { One: 1, Beside: 2 },
    Uri: { parse: uri, joinPath: (base, ...parts) => uri(`${base.toString()}/${parts.join('/')}`) },
    env: { language: 'en' }, languages: { match: () => 1,
      createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }), registerCodeLensProvider: disposable },
    commands: { registerCommand: (id, callback) => { callbacks.set(id, callback); return disposable(); }, executeCommand: async () => {} },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, inspect: () => undefined }),
      onDidChangeConfiguration: (listener) => { configurationListeners.push(listener); return disposable(); },
      registerTextDocumentContentProvider: disposable,
      openTextDocument: async () => vscode.window.activeTextEditor.document,
      fs: { stat: async (value) => { stats.push(value.toString()); return stat(value); } },
    },
    window: {
      activeTextEditor: document(),
      registerWebviewViewProvider: (_id, sidebar) => {
        sidebarProvider = sidebar;
        sidebar.view = { webview: { postMessage: (state) => states.push(state) } };
        return disposable();
      },
      onDidChangeActiveTextEditor: disposable,
      createOutputChannel: () => ({ info: (line) => logs.push(line), error: (line) => logs.push(line) }),
      showInformationMessage: async (...args) => { messages.push(['info', ...args]); return answer; },
      showWarningMessage: async (...args) => { messages.push(['warning', ...args]); return answer; },
      showErrorMessage: async (...args) => { messages.push(['error', ...args]); return answer; },
      showQuickPick: async (items) => items[0],
      withProgress: async (_options, callback) => callback({}, { isCancellationRequested: false, onCancellationRequested: disposable }),
    },
  };
  const context = { extensionUri: uri('file:///extension'), subscriptions: [],
    globalState: { get: () => 1 }, secrets: { get: async () => 'synthetic-test-api-key' }, workspaceState: {
    get: (key) => stateValues.get(key),
    update: async (key, value) => { writes.push({ key, value }); await write(value); stateValues.set(key, value); },
  } };
  class Renderer { show(value) { renders.push(value.toString()); } dispose() {} }
  const saves = [];
  const result = options.result ?? { issues: [], chunks: [], rewritten: '', overallComment: '' };
  const provider = {
    createProvider: async () => ({
      name: 'gemini',
      complete: async (prompt) => { sourcePrompts.push(prompt); return options.sourceResult ?? 'Nội dung mẫu.'; },
    }),
    requestReview: async (...args) => { reviews.push(args); return result; },
  };
  const extension = loadTs('src/extension.ts', options.realLocal ? { vscode } : {
    vscode,
    './llm/secrets': { migrateLegacyLlmConfig: async () => {} },
    './review/inline': { InlineRenderer: Renderer }, './review/diff': { DiffRenderer: Renderer }, './review/panel': { PanelRenderer: Renderer },
    './llm/provider': provider, '../llm/provider': provider,
    './anki/save': { saveQueuedChunksToAnki: async (...args) => saves.push(args) },
  });
  return {
    vscode, context, callbacks, messages, logs, writes, stats, renders, saves, states, result, reviews, sourcePrompts,
    start: async () => { const api = await extension.activate(context); await tick(); return api; },
    run: async (id, ...args) => { assert.equal(typeof callbacks.get(`onewriter.${id}`), 'function', `missing command ${id}`); return callbacks.get(`onewriter.${id}`)(...args); },
    setWrite: (fn) => { write = fn; }, setStat: (fn) => { stat = fn; }, setAnswer: (value) => { answer = value; },
    setSetting: (key, value) => { settings[key] = value; },
    resolveSidebar: () => sidebarProvider.resolveWebviewView({
      onDidDispose: disposable,
      webview: {
        set html(value) { sidebarHtml.push(value); },
        cspSource: 'vscode-webview:',
        asWebviewUri: (value) => value,
        onDidReceiveMessage: disposable,
        postMessage: (state) => states.push(state),
      },
    }),
    sidebarHtml,
    fireOneWriterConfigurationChange: () => configurationListeners.forEach((listener) => {
      listener({ affectsConfiguration: (section) => section === 'onewriter' });
    }),
    persisted: () => stateValues.get('onewriter.chunkQueue.v1'),
    reviewPersisted: () => stateValues.get('onewriter.reviewSessions.v1'),
  };
}

test('generateSource inserts native-language Source while preserving front matter and learner draft', async () => {
  const h = setup({ sourceResult: 'Tôi thức dậy lúc bảy giờ.' });
  await h.start();
  const editor = document([
    '---', 'lang: ja', 'level: N2', 'style: polite',
    'topic: một ngày làm việc của tôi', '---', '', '私の下書きです。',
  ].join('\n'));
  h.vscode.window.activeTextEditor = editor;

  await h.run('generateSource');

  assert.equal(editor.document.getText(), [
    '---', 'lang: ja', 'level: N2', 'style: polite',
    'topic: một ngày làm việc của tôi', '---', '',
    '## Source', '', 'Tôi thức dậy lúc bảy giờ.', '',
    '## Writing', '', '私の下書きです。', '',
  ].join('\n'));
  assert.match(h.sourcePrompts[0], /Vietnamese/);
  assert.match(h.sourcePrompts[0], /một ngày làm việc của tôi/);
});

test('generateSource requires a topic without calling the provider', async () => {
  const h = setup(); await h.start();
  h.vscode.window.activeTextEditor = document('---\nlang: ja\nlevel: N2\n---\n\n私の下書きです。');

  await h.run('generateSource');

  assert.equal(h.sourcePrompts.length, 0);
  assert.match(h.messages.at(-1)[1], /topic/i);
});

test('review with Source sends only Writing plus the source reference', async () => {
  const result = {
    issues: [], chunks: [], rewritten: '私は毎朝七時に起きて、仕事へ行きます。',
    overallComment: '内容は一致しています。',
  };
  const h = setup({ result }); await h.start();
  h.vscode.window.activeTextEditor = document([
    '---', 'lang: ja', 'level: N2', 'topic: 朝', '---', '',
    '## Source', '', 'Tôi thức dậy lúc bảy giờ.', '',
    '## Writing', '', '私は毎朝七時に起きて、朝ご飯を食べてから仕事へ行きます。',
  ].join('\n'));

  await h.run('review');

  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0][1], '私は毎朝七時に起きて、朝ご飯を食べてから仕事へ行きます。');
  assert.equal(h.reviews[0][4], 'Tôi thức dậy lúc bảy giờ.');
  assert.match(result.rewritten, /^---[\s\S]*## Source[\s\S]*## Writing/);
  assert.match(result.rewritten, /私は毎朝七時に起きて、仕事へ行きます。$/);
});

test('activation exposes the Markdown-It extension API', async () => {
  const h = setup();
  const api = await h.start();
  let installed = false;
  const md = { block: { ruler: { before: () => { installed = true; } } } };

  assert.equal(typeof api?.extendMarkdownIt, 'function');
  assert.equal(api.extendMarkdownIt(md), md);
  assert.equal(installed, true);
});

test('changing UI language through configuration rebuilds the resolved sidebar labels', async () => {
  const h = setup();
  await h.start();
  h.resolveSidebar();
  assert.match(h.sidebarHtml.at(-1), /"sidebar\.switch":"Switch language"/);

  h.setSetting('uiLanguage', 'vi');
  h.fireOneWriterConfigurationChange();

  assert.match(h.sidebarHtml.at(-1), /"sidebar\.switch":"Đổi ngôn ngữ"/);
});

for (const [name, editor, expected] of [
  ['untitled', document('Some selected text.', 'untitled:///writing', 0, 4), /save.*file/i],
  ['empty', document('  ', 'file:///writing.md', 0, 2), /select/i],
  ['oversized', document('x'.repeat(201), 'file:///writing.md', 0, 201), /200/],
]) {
  test(`add selection rejects ${name} before persistence`, async () => {
    const h = setup(); await h.start(); h.vscode.window.activeTextEditor = editor;
    await h.run('addSelectionToChunks');
    assert.equal(h.writes.length, 0);
    assert.match(h.messages.at(-1)[1], expected);
  });
}

test('saved remote selection uses document offsets, sentence context and front matter configuration; duplicate adds do not write', async () => {
  const h = setup(); await h.start();
  const text = '---\nlang: ja\nlevel: N2\nstyle: formal\n---\n前の文。今日はいい天気ですね。';
  const start = text.indexOf('いい');
  const editor = document(text, 'vscode-remote://ssh-remote+host/writing.md', start, start + 4);
  h.vscode.window.activeTextEditor = editor;
  await h.run('addSelectionToChunks');
  assert.deepEqual(editor.offsets, [editor.selection.start, editor.selection.end]);
  const [item] = h.persisted().items;
  assert.equal(item.uri, 'vscode-remote://ssh-remote+host/writing.md');
  assert.equal(item.chunk, 'いい天気');
  assert.equal(item.context, '今日はいい天気ですね。');
  assert.equal(item.targetLanguage, 'ja'); assert.equal(item.nativeLanguage, 'vi');
  assert.equal(item.level, 'N2'); assert.equal(item.style, 'formal'); assert.equal(item.source, 'selection');
  assert.equal(h.states.at(-1).payload.chunkCount, 1);
  await h.run('addSelectionToChunks');
  assert.equal(h.writes.length, 1); assert.match(h.messages.at(-1)[1], /already/i);
});

test('selection in the first body sentence immediately after front matter captures only body context', async () => {
  const h = setup(); await h.start();
  const text = '---\nlang: en\nlevel: B2\n---\nWe look forward to your reply. Next sentence.';
  h.vscode.window.activeTextEditor = document(text, 'file:///writing.md', text.indexOf('look'), text.indexOf(' to') + 3);
  await h.run('addSelectionToChunks');
  assert.equal(h.persisted().items[0].context, 'We look forward to your reply.');
  assert.equal(h.persisted().items[0].level, 'B2');
});

for (const endInBody of [false, true]) {
  test(`selection ${endInBody ? 'crossing' : 'within'} front matter is rejected with a local message`, async () => {
    const h = setup(); await h.start();
    const text = '---\nlang: en\n---\nWe look forward to your reply.';
    h.vscode.window.activeTextEditor = document(text, 'file:///writing.md', 4, endInBody ? text.indexOf('look') + 4 : 12);
    await h.run('addSelectionToChunks');
    assert.equal(h.writes.length, 0);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0][1], /body.*front matter/i);
    assert.doesNotMatch(JSON.stringify(h.messages), /lang: en/);
  });
}

test('remove awaits durable mutation before announcing success', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  let release; h.setWrite(() => new Promise((resolve) => { release = resolve; }));
  const before = h.messages.length;
  const removing = h.run('removeQueuedChunk', h.persisted().items[0].id);
  await tick(); assert.equal(h.messages.length, before); assert.equal(h.persisted().items.length, 1);
  release(); await removing;
  assert.equal(h.persisted().items.length, 0); assert.match(h.messages.at(-1)[1], /removed/i);
});

test('remove without an ID lets the user pick an active-file queued chunk', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  await h.run('removeQueuedChunk');
  assert.equal(h.persisted().items.length, 0);
});

test('clear confirms and awaits the active file mutation while preserving other files', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  h.vscode.window.activeTextEditor = document('We look forward to your reply.', 'file:///other.md');
  await h.run('addSelectionToChunks');
  await h.run('clearCurrentFileChunks');
  assert.equal(h.persisted().items.length, 2);
  const confirmation = h.messages.at(-1);
  assert.equal(confirmation[2].modal, true);
  h.setAnswer(confirmation[3]);
  let release; h.setWrite(() => new Promise((resolve) => { release = resolve; }));
  const clearing = h.run('clearCurrentFileChunks'); await tick();
  assert.equal(h.persisted().items.length, 2);
  release(); await clearing;
  assert.deepEqual(h.persisted().items.map((item) => item.uri), ['file:///writing.md']);
  assert.match(h.messages.at(-1)[1], /1/);
});

test('explicit clean reports its removed count', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  h.setStat(async () => { throw { code: 'FileNotFound' }; });
  await h.run('cleanChunkQueue');
  assert.equal(h.persisted().items.length, 0); assert.match(h.messages.at(-1)[1], /1/);
});

test('activation cleans each stored document once silently', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  const next = setup({ persisted: h.persisted() });
  next.setStat(async () => { throw { code: 'FileNotFound' }; });
  await next.start();
  assert.deepEqual(next.stats, ['file:///writing.md']);
  assert.equal(next.persisted().items.length, 0); assert.deepEqual(next.messages, []);
});

test('startup cleanup failure is silent and logs no error prose or stack', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  const next = setup({ persisted: h.persisted() });
  next.setStat(async () => { throw { code: 'FileNotFound' }; });
  next.setWrite(async () => { throw new Error('private-document-secret'); });
  await next.start();
  assert.deepEqual(next.messages, []);
  assert.match(next.logs.join('\n'), /Chunk queue cleanup failed/);
  assert.doesNotMatch(next.logs.join('\n'), /private-document-secret|Error:|at /);
});

for (const command of ['addSelectionToChunks', 'removeQueuedChunk', 'clearCurrentFileChunks', 'cleanChunkQueue']) {
  test(`${command} persistence failure is localized and preserves the queue`, async () => {
    const h = setup(); await h.start(); await h.run('addSelectionToChunks');
    const before = h.persisted();
    h.setWrite(async () => { throw new Error('private-document-secret'); });
    if (command === 'addSelectionToChunks') h.vscode.window.activeTextEditor = document('We await your reply.', 'file:///writing.md', 3, 8);
    if (command === 'clearCurrentFileChunks') { await h.run(command); h.setAnswer(h.messages.at(-1)[3]); }
    if (command === 'cleanChunkQueue') h.setStat(async () => { throw { code: 'FileNotFound' }; });
    await h.run(command, command === 'removeQueuedChunk' ? before.items[0].id : undefined);
    assert.deepEqual(h.persisted(), before);
    assert.equal(h.messages.at(-1)[0], 'error'); assert.match(h.messages.at(-1)[1], /queue/i);
    assert.doesNotMatch(JSON.stringify([h.messages, h.logs]), /private-document-secret/);
  });
}

test('saveToAnki forwards the active document queue without a review session', async () => {
  const h = setup(); await h.start(); await h.run('addSelectionToChunks');
  await h.run('saveToAnki');
  assert.equal(h.saves.length, 1);
  const [context, queue, target] = h.saves[0];
  assert.equal(context, h.context); assert.equal(target, h.vscode.window.activeTextEditor.document.uri);
  assert.equal(queue.list(target).length, 1); assert.ok(h.context.subscriptions.includes(queue));
});

function reviewWithChunk() {
  return { issues: [], rewritten: 'A revision.', overallComment: '', chunks: [
    { id: 'chunk-0', chunk: 'look forward to', meaning: 'mong chờ', context: 'We look forward to your reply.', source: 'upgrade' },
  ] };
}

for (const value of ['file:///writing.md', 'untitled:///writing']) {
  test(`cancelled required save for ${value} stops review and queue persistence`, async () => {
    const h = setup({ result: reviewWithChunk() }); await h.start();
    const editor = document(undefined, value);
    editor.document.isDirty = true;
    let saves = 0;
    editor.document.save = async () => { saves++; return false; };
    h.vscode.window.activeTextEditor = editor;
    await h.run('review');
    assert.equal(saves, 1);
    assert.deepEqual(h.renders, []);
    assert.equal(h.writes.length, 0);
  });
}

test('untitled review requests save even when clean and uses the resulting durable URI', async () => {
  const h = setup({ result: reviewWithChunk() }); await h.start();
  const editor = document(undefined, 'untitled:///writing');
  editor.document.isDirty = false;
  let saves = 0;
  editor.document.save = async () => { saves++; editor.document.uri = uri('vscode-remote://ssh-remote+host/saved.md'); return true; };
  h.vscode.window.activeTextEditor = editor;
  await h.run('review');
  assert.equal(saves, 1);
  assert.deepEqual(h.renders, ['vscode-remote://ssh-remote+host/saved.md']);
  assert.deepEqual(h.persisted().items.map((item) => item.uri), ['vscode-remote://ssh-remote+host/saved.md']);
});

test('successful Save As follows the durable active document replacing the closed untitled document', async () => {
  const h = setup({ result: reviewWithChunk() }); await h.start();
  const original = document(undefined, 'untitled:///writing');
  const saved = document(undefined, 'file:///saved.md');
  original.document.isDirty = true;
  original.document.save = async () => {
    original.document.isClosed = true;
    h.vscode.window.activeTextEditor = saved;
    return true;
  };
  h.vscode.window.activeTextEditor = original;
  await h.run('review');
  assert.deepEqual(h.renders, ['file:///saved.md']);
  assert.deepEqual(h.persisted().items.map((item) => item.uri), ['file:///saved.md']);
});

for (const switchEditor of [false, true]) {
  test(`a save returning true without a durable source stops review${switchEditor ? ' despite an unrelated active editor' : ''}`, async () => {
    const h = setup({ result: reviewWithChunk() }); await h.start();
    const original = document(undefined, 'untitled:///writing');
    original.document.isDirty = true;
    original.document.save = async () => {
      if (switchEditor) h.vscode.window.activeTextEditor = document(undefined, 'file:///unrelated.md');
      return true;
    };
    h.vscode.window.activeTextEditor = original;
    await h.run('review');
    assert.deepEqual(h.renders, []);
    assert.equal(h.writes.length, 0);
    assert.match(h.messages.at(-1)[1], /save.*file/i);
  });
}

test('direct untitled controller review retains rendering and the review store while skipping chunk persistence', async () => {
  const h = setup({ result: reviewWithChunk() }); await h.start();
  const reviewStore = h.context.subscriptions.find((item) => typeof item?.pending === 'function');
  const queue = h.context.subscriptions.find((item) => typeof item?.addMany === 'function');
  const { ReviewController } = loadTs('src/review/controller.ts', {
    vscode: h.vscode,
    '../llm/provider': { createProvider: async () => ({ name: 'gemini' }), requestReview: async () => h.result },
  });
  const renderer = { show: (value) => h.renders.push(value.toString()) };
  const controller = new ReviewController(h.context, reviewStore, renderer, renderer, queue);
  const unsaved = document(undefined, 'untitled:///writing').document;
  await controller.review(unsaved);
  assert.deepEqual(h.renders, ['untitled:///writing']);
  assert.equal(reviewStore.get(unsaved.uri).result, h.result);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(queue.list(), []);
  assert.match(h.messages.at(-1)[1], /save.*file/i);
});

test('successful review batches candidates preserving context/source and renders before persistence completes', async () => {
  const result = { issues: [], rewritten: 'A revision.', overallComment: '', chunks: [
    { chunk: 'look forward to', meaning: 'anticipate', context: 'Original candidate sentence.', source: 'mistake' },
    { chunk: 'keep in mind', meaning: 'remember', context: 'Another candidate sentence.', source: 'upgrade' },
  ] };
  const h = setup({ result }); await h.start();
  let release; h.setWrite(() => new Promise((resolve) => { release = resolve; }));
  const reviewing = h.run('review'); await tick();
  assert.deepEqual(h.renders, ['file:///writing.md']);
  assert.deepEqual(h.writes.map(({ key }) => key).sort(), [
    'onewriter.chunkQueue.v1', 'onewriter.reviewSessions.v1',
  ]);
  release(); await reviewing;
  assert.deepEqual(h.persisted().items.map(({ chunk, context, source }) => ({ chunk, context, source })), [
    { chunk: 'look forward to', context: 'Original candidate sentence.', source: 'mistake' },
    { chunk: 'keep in mind', context: 'Another candidate sentence.', source: 'upgrade' },
  ]);
  for (const item of h.persisted().items) {
    assert.equal(item.uri, 'file:///writing.md'); assert.equal(item.targetLanguage, 'en');
    assert.equal(item.nativeLanguage, 'vi'); assert.equal(item.level, 'B1'); assert.equal(item.style, 'polite');
  }
  assert.deepEqual(result.chunks.map((candidate) => Object.keys(candidate)), [
    ['chunk', 'meaning', 'context', 'source'], ['chunk', 'meaning', 'context', 'source'],
  ]);
});

test('review queue persistence failure preserves the stored/rendered review and reports a safe error', async () => {
  const h = setup({ result: { issues: [], rewritten: '', overallComment: '', chunks: [
    { chunk: 'look forward to', context: 'Original.', source: 'upgrade' },
  ] } });
  await h.start(); h.setWrite(async () => { throw new Error('private-review-secret'); });
  await h.run('review');
  assert.deepEqual(h.renders, ['file:///writing.md']);
  const reviewStore = h.context.subscriptions.find((item) => typeof item?.pending === 'function');
  assert.equal(reviewStore.get(h.vscode.window.activeTextEditor.document.uri).result, h.result);
  assert.match(h.messages.find((entry) => entry[0] === 'error')[1], /queue/i);
  assert.doesNotMatch(JSON.stringify([h.messages, h.logs]), /private-review-secret|Review failed/);
});

test('a persisted review reopens after activation in the requested mode without calling the LLM', async () => {
  const first = setup({ result: reviewWithChunk() });
  await first.start();
  await first.run('review');
  assert.equal(first.reviews.length, 1);
  assert.ok(first.reviewPersisted());

  const reopened = setup({
    persisted: first.persisted(),
    reviewPersisted: first.reviewPersisted(),
  });
  await reopened.start();
  await reopened.run('showLastReview', uri('file:///writing.md'), 'diff');

  assert.deepEqual(reopened.renders, ['file:///writing.md']);
  assert.equal(reopened.reviews.length, 0);
  assert.equal(reopened.reviewPersisted().sessions[0].displayMode, 'diff');
});

test('ordinary reopen uses the restored per-file display mode', async () => {
  const first = setup({ result: reviewWithChunk() });
  await first.start();
  await first.run('review');
  const saved = first.reviewPersisted();
  saved.sessions[0].displayMode = 'diff';

  const reopened = setup({ reviewPersisted: saved });
  await reopened.start();
  await reopened.run('showLastReview', uri('file:///writing.md'));

  assert.equal(reopened.reviewPersisted().sessions[0].displayMode, 'diff');
  assert.equal(reopened.reviews.length, 0);
});

test('clearReview removes the durable result so it cannot be reopened', async () => {
  const h = setup({ result: reviewWithChunk() });
  await h.start();
  await h.run('review');
  await h.run('clearReview', uri('file:///writing.md'));

  assert.deepEqual(h.reviewPersisted().sessions, []);
  const before = h.renders.length;
  await h.run('showLastReview', uri('file:///writing.md'), 'webview');
  assert.equal(h.renders.length, before);
  assert.match(h.messages.at(-1)[1], /no saved review/i);
});

test('runtime queue messages and mixed save counts have Vietnamese and Japanese translations', async () => {
  const keys = ['chunks.added', 'chunks.duplicate', 'chunks.empty', 'chunks.tooLong', 'chunks.untitled',
    'chunks.removed', 'chunks.pickRemove', 'chunks.clearConfirm', 'chunks.clearAction', 'chunks.cleared',
    'chunks.cleaned', 'chunks.persistenceFailed', 'chunks.frontMatter', 'anki.queueSummary', 'anki.queueCommitFailed'];
  const values = {};
  for (const locale of ['en', 'vi', 'ja']) {
    const h = setup({ locale });
    const { t } = loadTs('src/i18n.ts', { vscode: h.vscode });
    values[locale] = keys.map((key) => t(key, { chunk: 'label', count: 2, added: 1, duplicates: 2, enrichmentFailed: 3, ankiFailed: 4 }));
    values[locale].forEach((message) => assert.doesNotMatch(message, /\{\w+\}/));
  }
  for (const locale of ['vi', 'ja']) values[locale].forEach((message, index) => assert.notEqual(message, values.en[index]));
});

// These integration regressions must reach the real local workflow and renderer.
// Only VS Code and HTTP responses are controlled; no save/controller substitutes.
test('real save callback uses the explicit remote URI instead of the active document without a review', async (t) => {
  const h = setup({ realLocal: true }); await h.start();
  await h.run('addSelectionToChunks');
  const active = h.vscode.window.activeTextEditor;
  const selected = document('Please keep in mind this advice.', 'vscode-remote://ssh-remote+host/target.md', 7, 19);
  h.vscode.window.activeTextEditor = selected;
  await h.run('addSelectionToChunks');
  const targetItem = h.persisted().items.find((item) => item.uri === selected.document.uri.toString());
  h.vscode.window.activeTextEditor = active;
  const opened = [], picks = [], http = [];
  h.vscode.workspace.openTextDocument = async (target) => {
    opened.push(target.toString());
    assert.equal(target.toString(), 'vscode-remote://ssh-remote+host/target.md');
    return selected.document;
  };
  const getConfiguration = h.vscode.workspace.getConfiguration;
  h.vscode.workspace.getConfiguration = (section, resource) => {
    const config = getConfiguration(section, resource);
    return { ...config, get: (key, fallback) => key === 'llm.gemini.model'
      ? (resource?.toString() === selected.document.uri.toString() ? 'explicit-target-model' : 'wrong-active-model')
      : config.get(key, fallback) };
  };
  h.vscode.window.showQuickPick = async (items, options) => {
    assert.equal(options.canPickMany, true);
    picks.push(items.map((item) => item.label));
    return items;
  };
  t.mock.method(global, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body); http.push({ url, body });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [
        { id: targetItem.id, meaning: 'ghi nhớ', example: 'Keep in mind the deadline.', note: null },
      ] }) }] } }] }));
    }
    assert.equal(url, 'http://127.0.0.1:8765');
    const results = { version: 6, modelNames: ['OneWriter Chunk'], deckNames: ['OneWriter::en'], canAddNotes: [true], addNotes: [8271] };
    assert.ok(body.action in results, body.action);
    return new Response(JSON.stringify({ error: null, result: results[body.action] }));
  });
  await h.run('saveToAnki', selected.document.uri);
  assert.equal(http.length, 6, 'real enrichment and Anki requests must occur');
  assert.deepEqual(opened, ['vscode-remote://ssh-remote+host/target.md']);
  assert.deepEqual(picks, [['keep in mind']]);
  assert.match(http[0].url, /models\/explicit-target-model:generateContent$/);
  assert.match(JSON.stringify(http[0].body), /Please keep in mind this advice/);
  assert.doesNotMatch(JSON.stringify(http[0].body), /look forward/);
  const added = http.find(({ body }) => body.action === 'addNotes').body.params.notes;
  assert.deepEqual(added.map((note) => note.fields), [{
    Chunk: 'keep in mind', Meaning: 'ghi nhớ', Context: 'Please keep in mind this advice.',
    Corrected: 'Keep in mind the deadline.', Note: '', Source: 'target.md',
  }]);
  assert.deepEqual(h.persisted().items.map((item) => item.uri), ['file:///writing.md']);
  assert.match(h.messages.at(-1)[1], /1 added, 0 duplicates/);
  const store = h.context.subscriptions.find((item) => typeof item?.pending === 'function');
  assert.equal(store.get(selected.document.uri), undefined);
});

test('real panel renders and retains a successful review when queue persistence rejects', async (t) => {
  const h = setup({ realLocal: true }); await h.start();
  const panels = [], posts = [];
  h.vscode.window.createWebviewPanel = (...args) => {
    const panel = {
      webview: { cspSource: 'test-webview:', asWebviewUri: (value) => value,
        postMessage: (message) => { posts.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: (listener) => { panel.receive = listener; return disposable(); } },
      reveal() {}, onDidDispose: disposable, dispose() {},
    };
    panels.push({ args, panel }); return panel;
  };
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    issues: [], rewritten: 'We look forward to your reply.', overallComment: 'Clear and natural writing.',
    chunks: [{ chunk: 'look forward to', meaning: 'mong chờ', context: 'We look forward to your reply.', source: 'upgrade' }],
  }) }] } }] })));
  let rejectWrite;
  h.setWrite(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
  const reviewing = h.run('review'); await tick();
  assert.equal(panels.length, 1, 'real renderer must create a VS Code webview panel');
  assert.match(panels[0].panel.webview.html, /id="anki"/);
  assert.deepEqual(posts.at(-1), { type: 'render', payload: {
    fileName: 'writing.md', level: 'EN · B1', comment: 'Clear and natural writing.', chunkCount: 1, issues: [],
  } });
  rejectWrite(new Error('private-review-secret')); await reviewing;
  assert.match(h.messages.find((entry) => entry[0] === 'error')[1], /queue/i);
  panels[0].panel.receive({ type: 'ready' });
  assert.deepEqual(posts.at(-1), posts[0], 'panel can render the same stored review after rejection');
  assert.ok(posts.every((message) => message.type === 'render'));
  assert.doesNotMatch(JSON.stringify([h.messages, h.logs]), /private-review-secret|Review failed/);
  const dispatched = [];
  h.vscode.commands.executeCommand = async (...args) => dispatched.push(args);
  h.vscode.window.activeTextEditor = document('Another unrelated document.', 'file:///other.md');
  panels[0].panel.receive({ type: 'anki' });
  assert.equal(dispatched[0][0], 'onewriter.saveToAnki');
  assert.equal(dispatched[0][1].toString(), 'file:///writing.md');
});
