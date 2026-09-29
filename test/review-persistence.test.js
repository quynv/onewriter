const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

class EventEmitter {
  constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners = []; }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

function uri(value) {
  return {
    scheme: value.slice(0, value.indexOf(':')),
    path: new URL(value).pathname,
    toString: () => value,
  };
}

const missing = new Set();
const statErrors = new Map();
const vscode = {
  EventEmitter,
  Range,
  Uri: { parse: uri },
  env: { language: 'en' },
  commands: { executeCommand: async () => {} },
  window: { activeTextEditor: undefined },
  workspace: {
    fs: {
      stat: async (target) => {
        const value = target.toString();
        if (statErrors.has(value)) throw statErrors.get(value);
        if (missing.has(value)) throw { code: 'FileNotFound' };
        return { type: 1 };
      },
    },
  },
};

const { ReviewStore } = loadTs('src/review/store.ts', { vscode });

function state(seed) {
  const values = new Map(seed ? [['onewriter.reviewSessions.v1', seed]] : []);
  return {
    values,
    get: (key) => values.get(key),
    update: async (key, value) => values.set(key, value),
  };
}

const config = {
  nativeLanguage: 'vi', targetLanguage: 'ja', level: 'N2', style: 'polite',
  explanationLanguage: 'native', showBetter: true, maxChunks: 8, reviewMode: 'diff',
};

function session(value = 'file:///writing.md') {
  return {
    uri: uri(value),
    result: {
      issues: [{
        id: 'issue-0', original: '私は', replacement: '私が', category: 'grammar',
        severity: 2, explanation: '助詞', range: new Range(5, 0, 5, 2),
      }],
      chunks: [{ id: 'chunk-0', chunk: '心掛ける', meaning: 'ghi nhớ', context: '心掛けている。', source: 'upgrade' }],
      rewritten: '私が書きました。',
      overallComment: '良い文章です。',
    },
    config,
    displayMode: 'webview',
    originalText: '私は書きました。',
    createdAt: 42,
    resolved: new Set(['issue-0']),
  };
}

test('latest review survives a new ReviewStore with range, resolved state and display mode intact', async () => {
  const memento = state();
  const first = new ReviewStore(memento);
  await first.set(uri('file:///writing.md'), session());

  const restored = new ReviewStore(memento).get(uri('file:///writing.md'));
  assert.ok(restored);
  assert.equal(restored.uri.toString(), 'file:///writing.md');
  assert.equal(restored.result.overallComment, '良い文章です。');
  assert.deepEqual(restored.result.issues[0].range, new Range(5, 0, 5, 2));
  assert.deepEqual([...restored.resolved], ['issue-0']);
  assert.equal(restored.displayMode, 'webview');
});

test('review mutations replace the durable snapshot and clear removes it', async () => {
  const memento = state();
  const store = new ReviewStore(memento);
  await store.set(uri('file:///writing.md'), { ...session(), resolved: new Set() });
  await store.markResolved(uri('file:///writing.md'), 'issue-0');
  await store.setDisplayMode(uri('file:///writing.md'), 'codelens');

  let restored = new ReviewStore(memento).get(uri('file:///writing.md'));
  assert.deepEqual([...restored.resolved], ['issue-0']);
  assert.equal(restored.displayMode, 'codelens');

  await store.clear(uri('file:///writing.md'));
  restored = new ReviewStore(memento).get(uri('file:///writing.md'));
  assert.equal(restored, undefined);
});

test('cleanup removes only reviews whose files are confirmed missing', async () => {
  missing.clear(); statErrors.clear();
  const memento = state();
  const store = new ReviewStore(memento);
  await store.set(uri('file:///missing.md'), session('file:///missing.md'));
  await store.set(uri('file:///offline.md'), session('file:///offline.md'));
  missing.add('file:///missing.md');
  statErrors.set('file:///offline.md', new Error('remote unavailable'));

  assert.equal(await store.cleanDeleted(), 1);
  const restored = new ReviewStore(memento);
  assert.equal(restored.get(uri('file:///missing.md')), undefined);
  assert.ok(restored.get(uri('file:///offline.md')));
});

test('cleanup never deletes a newer review that replaced the checked session', async () => {
  missing.clear(); statErrors.clear();
  let rejectStat;
  vscode.workspace.fs.stat = () => new Promise((_resolve, reject) => { rejectStat = reject; });
  const store = new ReviewStore(state());
  const target = uri('file:///writing.md');
  const oldSession = session();
  await store.set(target, oldSession);

  const cleaning = store.cleanDeleted();
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = { ...session(), createdAt: 99, result: { ...session().result, overallComment: 'new' } };
  await store.set(target, replacement);
  rejectStat({ code: 'FileNotFound' });

  assert.equal(await cleaning, 0);
  assert.equal(store.get(target), replacement);
});

test('restoration rejects a malformed session atomically', () => {
  const valid = {
    uri: 'file:///good.md', result: session().result, config, displayMode: 'diff',
    originalText: 'text', createdAt: 1, resolved: [],
  };
  const envelope = { version: 1, sessions: [
    valid,
    { ...valid, uri: 'untitled:///draft' },
    { ...valid, uri: 'not a uri' },
    { ...valid, config: { ...config, targetLanguage: 'xx' } },
    { ...valid, result: { ...valid.result, issues: [{ ...valid.result.issues[0], severity: 9 }] } },
    { ...valid, result: { ...valid.result, chunks: [{ ...valid.result.chunks[0], source: 'unknown' }] } },
    { ...valid, createdAt: Number.NaN },
  ] };

  const store = new ReviewStore(state(envelope));
  const restored = store.get(uri('file:///good.md'));
  assert.ok(restored);
  assert.equal(restored.config.targetLanguage, 'ja');
  assert.equal(restored.result.issues[0].severity, 2);
  assert.equal(restored.result.chunks[0].source, 'upgrade');
  assert.equal(restored.createdAt, 1);
  assert.equal(store.get(uri('untitled:///draft')), undefined);
});

test('an existing result can switch renderers without running a new review', async () => {
  const { ReviewController } = loadTs('src/review/controller.ts', { vscode });
  const memento = state();
  const store = new ReviewStore(memento);
  const target = uri('file:///writing.md');
  await store.set(target, session());
  const shown = [];
  const controller = new ReviewController(
    {}, store,
    { show: async (value) => shown.push(['diff', value.toString()]) },
    { show: async (value) => shown.push(['webview', value.toString()]) },
    {},
  );

  assert.equal(await controller.showStored(target, 'diff'), true);
  assert.equal(await controller.showStored(target, 'webview'), true);
  assert.equal(await controller.showStored(target, 'codelens'), true);
  assert.deepEqual(shown, [
    ['diff', 'file:///writing.md'],
    ['webview', 'file:///writing.md'],
  ]);
  assert.equal(store.get(target).displayMode, 'codelens');
});

test('opening a missing stored result does not create an empty comparison', async () => {
  const { ReviewController } = loadTs('src/review/controller.ts', { vscode });
  const shown = [];
  const controller = new ReviewController(
    {}, new ReviewStore(state()),
    { show: async () => shown.push('diff') },
    { show: async () => shown.push('webview') },
    {},
  );

  assert.equal(await controller.showStored(uri('file:///none.md'), 'diff'), false);
  assert.deepEqual(shown, []);
});

test('switching mode renders before slow persistence finishes', async () => {
  const { ReviewController } = loadTs('src/review/controller.ts', { vscode });
  let release;
  const store = {
    get: () => session(),
    setDisplayMode: () => new Promise((resolve) => { release = resolve; }),
  };
  const shown = [];
  const controller = new ReviewController(
    {}, store,
    { show: async () => shown.push('diff') },
    { show: async () => shown.push('webview') },
    {},
  );

  const opening = controller.showStored(uri('file:///writing.md'), 'diff');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, ['diff']);
  release(true);
  assert.equal(await opening, true);
});

test('a slow resolved-state write cannot overwrite a newer review session', async () => {
  let release;
  const oldSession = session();
  const newerSession = { ...session(), createdAt: 100, result: { ...session().result, overallComment: 'newer' } };
  let current = oldSession;
  const writes = [];
  const store = {
    get: () => current,
    markResolved: () => new Promise((resolve) => { release = resolve; }),
    pending: () => [],
    set: async (_uri, value) => { writes.push(value); current = value; },
  };
  class WorkspaceEdit { replace() {} }
  const controllerVscode = {
    ...vscode,
    WorkspaceEdit,
    workspace: {
      ...vscode.workspace,
      openTextDocument: async () => ({
        getText: (range) => range ? '私は' : '私が書きました。',
      }),
      applyEdit: async () => true,
    },
    window: { ...vscode.window, showWarningMessage: async () => {}, showErrorMessage: async () => {} },
  };
  const { ReviewController } = loadTs('src/review/controller.ts', { vscode: controllerVscode });
  const controller = new ReviewController({}, store, {}, {}, {});

  const applying = controller.applyIssue(uri('file:///writing.md'), 'issue-0');
  await new Promise((resolve) => setImmediate(resolve));
  current = newerSession;
  release();
  await applying;

  assert.deepEqual(writes, []);
  assert.equal(current, newerSession);
});

test('an editor write completing after a new review does not resolve the new session', async () => {
  let releaseEdit;
  const oldSession = session();
  const newerSession = { ...session(), createdAt: 101 };
  let current = oldSession;
  let resolvedCalls = 0;
  const store = {
    get: () => current,
    markResolved: async () => { resolvedCalls++; },
    pending: () => [],
    set: async () => assert.fail('stale session must not be stored'),
  };
  class WorkspaceEdit { replace() {} }
  const controllerVscode = {
    ...vscode, WorkspaceEdit,
    workspace: {
      ...vscode.workspace,
      openTextDocument: async () => ({ getText: (range) => range ? '私は' : '私が書きました。' }),
      applyEdit: () => new Promise((resolve) => { releaseEdit = resolve; }),
    },
    window: { ...vscode.window, showWarningMessage: async () => {}, showErrorMessage: async () => {} },
  };
  const { ReviewController } = loadTs('src/review/controller.ts', { vscode: controllerVscode });
  const applying = new ReviewController({}, store, {}, {}, {})
    .applyIssue(uri('file:///writing.md'), 'issue-0');
  await new Promise((resolve) => setImmediate(resolve));
  current = newerSession;
  releaseEdit(true);
  await applying;

  assert.equal(resolvedCalls, 0);
  assert.equal(current, newerSession);
});

test('opening the edited document after a new review does not restore the stale session', async () => {
  let releaseSecondOpen;
  let signalSecondOpen;
  const secondOpenStarted = new Promise((resolve) => { signalSecondOpen = resolve; });
  const oldSession = session();
  const newerSession = { ...session(), createdAt: 102 };
  let current = oldSession;
  const writes = [];
  const store = {
    get: () => current,
    markResolved: async () => {},
    pending: () => [],
    set: async (_uri, value) => { writes.push(value); current = value; },
  };
  let opens = 0;
  const editedDocument = { getText: (range) => range ? '私は' : '私が書きました。' };
  class WorkspaceEdit { replace() {} }
  const controllerVscode = {
    ...vscode, WorkspaceEdit,
    workspace: {
      ...vscode.workspace,
      openTextDocument: async () => {
        opens++;
        if (opens === 1) return editedDocument;
        signalSecondOpen();
        return new Promise((resolve) => { releaseSecondOpen = () => resolve(editedDocument); });
      },
      applyEdit: async () => true,
    },
    window: { ...vscode.window, showWarningMessage: async () => {}, showErrorMessage: async () => {} },
  };
  const { ReviewController } = loadTs('src/review/controller.ts', { vscode: controllerVscode });
  const applying = new ReviewController({}, store, {}, {}, {})
    .applyIssue(uri('file:///writing.md'), 'issue-0');
  await secondOpenStarted;
  current = newerSession;
  releaseSecondOpen();
  await applying;

  assert.deepEqual(writes, []);
  assert.equal(current, newerSession);
});

test('panel warns safely when keeping an issue cannot persist resolved state', async () => {
  const warnings = [];
  let receive;
  const panelVscode = {
    ...vscode,
    ViewColumn: { Beside: 2, One: 1 },
    Uri: { ...vscode.Uri, joinPath: (base, ...parts) => uri(`${base.toString()}/${parts.join('/')}`) },
    workspace: {
      ...vscode.workspace,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {
      ...vscode.window,
      createOutputChannel: () => ({ info() {}, error() {} }),
      showWarningMessage: async (message) => warnings.push(message),
      createWebviewPanel: () => ({
        webview: {
          cspSource: 'test:', asWebviewUri: (value) => value,
          postMessage: async () => true,
          onDidReceiveMessage: (listener) => { receive = listener; return { dispose() {} }; },
        },
        onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {},
      }),
    },
  };
  const { PanelRenderer } = loadTs('src/review/panel.ts', { vscode: panelVscode });
  const store = {
    onDidChange: () => ({ dispose() {} }),
    get: () => session(),
    markResolved: async () => { throw new Error('private-review-text'); },
  };
  const panel = new PanelRenderer(store, uri('file:///extension'));
  await panel.show(uri('file:///writing.md'));
  await receive({ type: 'skip', id: 'issue-0' });

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private-review-text/);
});

test('applying an issue relocates remaining issues from Writing rather than duplicate Source text', async () => {
  const text = [
    '---', 'lang: ja', '---', '',
    '## Source', '', '同じ表現があります。', '',
    '## Writing', '', '同じ表現があります。次の誤りです。',
  ].join('\n');
  const target = uri('file:///writing.md');
  const first = text.lastIndexOf('同じ表現');
  const reviewed = {
    ...session(), uri: target, resolved: new Set(),
    result: {
      ...session().result,
      issues: [
        { id: 'first', original: '同じ表現', replacement: 'この表現', category: 'better', severity: 1, explanation: 'x', range: { start: first, end: first + 4 } },
        { id: 'second', original: '次の誤り', replacement: '次の表現', category: 'grammar', severity: 2, explanation: 'y' },
      ],
    },
  };
  let locateOffset;
  const store = {
    get: () => reviewed,
    markResolved: async () => reviewed.resolved.add('first'),
    pending: () => [reviewed.result.issues[1]],
    set: async () => {},
  };
  class WorkspaceEdit { replace() {} }
  const controllerVscode = {
    ...vscode, WorkspaceEdit,
    workspace: {
      ...vscode.workspace,
      openTextDocument: async () => ({
        getText: (range) => range ? '同じ表現' : text,
      }),
      applyEdit: async () => true,
    },
    window: { ...vscode.window, showWarningMessage: async () => {}, showErrorMessage: async () => {} },
  };
  const { ReviewController } = loadTs('src/review/controller.ts', {
    vscode: controllerVscode,
    './locate': { locateIssues: (_document, issues, offset) => { locateOffset = offset; return issues; } },
  });

  await new ReviewController({}, store, {}, {}, {}).applyIssue(target, 'first');

  assert.equal(locateOffset, text.indexOf('同じ表現', text.indexOf('## Writing')));
});
