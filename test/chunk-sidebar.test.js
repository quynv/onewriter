const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const commands = [];
const states = [];
const renderedHtml = [];
const updates = [];
const warnings = [];
let receiveMessage;
let disposeView;
let activeUri = 'file:///a.md';
let updateFailure;
let uiLanguage = 'en';

function uri(value) {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    path: parsed.pathname,
    query: parsed.search.slice(1),
    toString: () => value,
    with: (changes) => uri(`${changes.scheme ?? parsed.protocol.slice(0, -1)}://${parsed.host}${parsed.pathname}${changes.query ? `?${changes.query}` : ''}`),
  };
}

const vscode = {
  ConfigurationTarget: { Global: 1 },
  Uri: {
    joinPath: (base, ...parts) => uri(`${base.toString()}/${parts.join('/')}`),
  },
  commands: {
    executeCommand: (...args) => commands.push(args),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => key === 'uiLanguage' ? uiLanguage : fallback,
      update: async (...args) => {
        updates.push(args);
        if (updateFailure) throw updateFailure;
      },
    }),
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: async (message) => warnings.push(message),
  },
};

const queued = [
  { id: 'a-1', uri: 'file:///a.md', chunk: 'look forward to', context: 'I look forward to Friday.' },
  { id: 'b-1', uri: 'file:///b.md', chunk: 'keep in mind', context: 'Keep this in mind.' },
];

function createSidebar(options = {}) {
  commands.length = 0;
  states.length = 0;
  renderedHtml.length = 0;
  updates.length = 0;
  warnings.length = 0;
  updateFailure = options.updateFailure;
  uiLanguage = 'en';
  receiveMessage = undefined;
  disposeView = undefined;
  vscode.window.activeTextEditor = { document: { uri: uri(activeUri), getText: () => '' } };
  const { SidebarProvider } = loadTs('src/ui/sidebar.ts', { vscode });
  const queue = {
    list: (documentUri) => queued.filter((item) => item.uri === documentUri.toString()),
  };
  const sidebar = new SidebarProvider(
    uri('file:///extension'),
    { get: (value) => options.hasReview
      && (!options.reviewUri || value.toString() === options.reviewUri)
      ? { result: { issues: [] }, resolved: new Set(),
      displayMode: options.displayMode } : undefined,
      pending: () => [], displayMode: (value) => value.displayMode ?? 'webview' },
    queue,
  );
  sidebar.resolveWebviewView({
    onDidDispose: (listener) => { disposeView = listener; return { dispose() {} }; },
    webview: {
      set html(value) { renderedHtml.push(value); },
      cspSource: 'vscode-webview:',
      asWebviewUri: (value) => value.toString(),
      onDidReceiveMessage: (listener) => { receiveMessage = listener; return { dispose() {} }; },
      postMessage: (state) => states.push(state),
    },
  });
  return sidebar;
}

test('refresh rebuilds visible sidebar labels after UI language changes', () => {
  const sidebar = createSidebar();
  assert.match(renderedHtml.at(-1), /"sidebar\.switch":"Switch language"/);

  sidebar.refresh();
  assert.equal(renderedHtml.length, 1);

  uiLanguage = 'vi';
  sidebar.refresh();

  assert.equal(renderedHtml.length, 2);
  assert.match(renderedHtml.at(-1), /"sidebar\.switch":"Đổi ngôn ngữ"/);
  assert.doesNotMatch(renderedHtml.at(-1), /"sidebar\.switch":"Switch language"/);
});

test('refresh ignores a sidebar view after it is disposed', () => {
  const sidebar = createSidebar();
  states.length = 0;

  assert.equal(typeof disposeView, 'function');
  disposeView();
  sidebar.refresh();

  assert.equal(renderedHtml.length, 1);
  assert.equal(states.length, 0);
});

test('sidebar refresh exposes only queued chunks for the active file', () => {
  activeUri = 'file:///a.md';
  const sidebar = createSidebar();
  assert.deepEqual(states.at(-1).payload.queuedChunks, [
    { id: 'a-1', chunk: 'look forward to', context: 'I look forward to Friday.' },
  ]);

  activeUri = 'file:///b.md';
  vscode.window.activeTextEditor = { document: { uri: uri(activeUri), getText: () => '' } };
  sidebar.refresh();
  assert.deepEqual(states.at(-1).payload.queuedChunks, [
    { id: 'b-1', chunk: 'keep in mind', context: 'Keep this in mind.' },
  ]);
});

test('sidebar queue messages dispatch only fixed commands and pass removal IDs opaquely', () => {
  createSidebar();
  const id = '\"><img src=x onerror=alert(1)>';
  receiveMessage({ type: 'removeChunk', id });
  receiveMessage({ type: 'clearChunks' });
  receiveMessage({ type: 'cleanChunks' });

  assert.deepEqual(commands, [
    ['onewriter.removeQueuedChunk', id],
    ['onewriter.clearCurrentFileChunks'],
    ['onewriter.cleanChunkQueue'],
  ]);
  assert.ok(!commands.some(([command]) => command === id));
  assert.deepEqual(updates, []);
});

test('changing display mode reopens an existing result without requesting another review', async () => {
  createSidebar({ hasReview: true });
  receiveMessage({ type: 'reviewMode', value: 'diff' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(updates, [['review.mode', 'diff', 1]]);
  assert.deepEqual(commands, [['onewriter.showLastReview', vscode.window.activeTextEditor.document.uri, 'diff']]);
});

test('sidebar reports the current per-file display mode instead of the next-review default', () => {
  createSidebar({ hasReview: true, displayMode: 'diff' });
  assert.equal(states.at(-1).payload.reviewMode, 'diff');
});

test('a settings write failure does not block switching the current result', async () => {
  createSidebar({ hasReview: true, updateFailure: new Error('private-setting-value') });
  receiveMessage({ type: 'reviewMode', value: 'webview' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(commands, [[
    'onewriter.showLastReview', vscode.window.activeTextEditor.document.uri, 'webview',
  ]]);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private-setting-value/);
});
