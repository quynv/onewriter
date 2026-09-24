const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

class CancellationError extends Error {}
const settings = new Map();
const messages = [], logs = [], commands = [], progressOptions = [];
let pick, pickedItems, token, progressHook, progressActive;
const uri = { path: '/writing/practice.md', toString: () => 'file:///writing/practice.md' };
const vscode = {
  CancellationError,
  EventEmitter: class { event = () => {}; fire() {} dispose() {} },
  ProgressLocation: { Notification: 1 },
  Uri: { parse: (value) => ({ path: decodeURIComponent(new URL(value).pathname) }) },
  env: { language: 'en', openExternal: async (value) => commands.push(value) },
  commands: { executeCommand: async (...args) => commands.push(args) },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback }) },
  window: {
    showQuickPick: async (items, options) => {
      pickedItems = items;
      assert.equal(options.canPickMany, true);
      assert.ok(items.every((item) => item.picked === true));
      return pick(items);
    },
    withProgress: async (options, run) => {
      progressOptions.push(options); progressHook?.(); progressActive = true;
      try { return await run({}, token); } finally { progressActive = false; }
    },
    showInformationMessage: async (...args) => messages.push(['info', ...args]),
    showWarningMessage: async (...args) => messages.push(['warning', ...args]),
    showErrorMessage: async (...args) => { messages.push(['error', ...args]); return undefined; },
    createOutputChannel: () => ({ info: (line) => logs.push(line), error: (line) => logs.push(line), show() {} }),
  },
};
const errorModule = loadTs('src/llm/errors.ts');
const clientModule = loadTs('src/anki/client.ts', { vscode });
const { LLMError } = errorModule;
const { AnkiClient, AnkiError } = clientModule;
const { ChunkQueueStore } = loadTs('src/chunks/store.ts', { vscode });
const { saveQueuedChunksToAnki } = loadTs('src/anki/save.ts', {
  vscode, '../llm/errors': errorModule, './errors': errorModule, './client': clientModule,
});
const context = { secrets: { get: async () => 'synthetic-secret' } };
const chunk = (id, extra = {}) => ({
  id, uri: uri.toString(), chunk: `chunk ${id}`, normalizedChunk: `chunk ${id}`,
  context: `original ${id}`, targetLanguage: 'en', nativeLanguage: 'vi', level: 'B1',
  style: 'plain', source: 'selection', addedAt: 1, ...extra,
});
const enriched = (id, extra = {}) => ({ id, meaning: `meaning ${id}`, example: `new ${id.toUpperCase()}`, ...extra });

function fixture(items = [chunk('a'), chunk('b')], persist = async () => {}) {
  let persisted = { version: 1, items };
  const queue = new ChunkQueueStore({ get: () => persisted, update: async (_key, value) => { await persist(); persisted = value; } });
  const client = {
    checkedNotes: [], addedNotes: [], checks: 0, adds: 0, createdDecks: [],
    version: async () => 6,
    modelNames: async () => ['OneWriter Chunk'],
    deckNames: async () => [],
    createDeck: async (deck) => client.createdDecks.push(deck),
    canAddNotes: async (notes) => { client.checks++; client.checkedNotes = notes; return notes.map(() => true); },
    addNotes: async (notes) => { client.adds++; client.addedNotes = notes; return notes.map((_, index) => 123 + index); },
  };
  const deps = {
    enrichCalls: [], providerCalls: [], clientCalls: 0,
    createProvider: async (...args) => { deps.providerCalls.push(args); return { name: 'qwen' }; },
    createClient: () => { deps.clientCalls++; return client; },
    enrich: async (_llm, selected, receivedToken) => {
      deps.enrichCalls.push(selected);
      assert.equal(receivedToken, token);
      return { enriched: selected.map((item) => enriched(item.id)), failedIds: [] };
    },
  };
  return { queue, deps, client, persistedIds: () => persisted.items.map((item) => item.id) };
}

test.beforeEach(() => {
  settings.clear(); settings.set('uiLanguage', 'en');
  messages.length = logs.length = commands.length = progressOptions.length = 0;
  pick = (items) => items; pickedItems = undefined; progressHook = undefined; progressActive = false;
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
});

test('empty document queue reports no chunks without opening a picker or services', async () => {
  const f = fixture([chunk('other', { uri: 'file:///other.md' })]);
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.equal(pickedItems, undefined);
  assert.equal(f.deps.providerCalls.length, 0);
  assert.equal(f.deps.clientCalls, 0);
  assert.match(messages[0][1], /no chunks/);
  assert.deepEqual(f.persistedIds(), ['other']);
});

for (const [name, answer] of [['cancelled', undefined], ['empty', []]]) {
  test(`${name} Quick Pick makes zero LLM calls and preserves every item`, async () => {
    const f = fixture(); pick = () => answer;
    await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
    assert.equal(f.deps.providerCalls.length, 0);
    assert.equal(f.deps.enrichCalls.length, 0);
    assert.equal(f.deps.clientCalls, 0);
    assert.deepEqual(f.persistedIds(), ['a', 'b']);
  });
}

test('partial enrichment joins by id and sends original context, new example and source to Anki', async () => {
  const f = fixture();
  f.deps.enrich = async (_llm, selected) => {
    f.deps.enrichCalls.push(selected);
    return { enriched: [enriched('outside'), enriched('a', { note: 'usage note' })], failedIds: ['b'] };
  };
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(f.deps.enrichCalls.map((items) => items.map((item) => item.id)), [['a', 'b']]);
  assert.deepEqual(f.client.addedNotes, [{
    deckName: 'OneWriter::en', modelName: 'OneWriter Chunk',
    fields: { Chunk: 'chunk a', Meaning: 'meaning a', Context: 'original a', Corrected: 'new A', Note: 'usage note', Source: 'practice.md' },
    tags: ['onewriter', 'lang::en', 'level::B1', 'src::selection'],
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  }]);
  assert.deepEqual(f.persistedIds(), ['b']);
  assert.equal(f.client.checks, 1); assert.equal(f.client.adds, 1);
  assert.match(messages.at(-1)[1], /1 added.*0 duplicate.*1 enrichment.*0 Anki/i);
});

test('out-of-order enrichment and null addNotes result remove only the exact successful paired item', async () => {
  const f = fixture([chunk('a'), chunk('b'), chunk('other', { uri: 'file:///other.md' })]);
  f.deps.enrich = async () => ({ enriched: [enriched('b'), enriched('a')], failedIds: [] });
  f.client.addNotes = async (notes) => { f.client.addedNotes = notes; return [123, null]; };
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(f.client.addedNotes.map((note) => note.fields.Corrected), ['new A', 'new B']);
  assert.equal(f.client.addedNotes[1].fields.Note, '');
  assert.deepEqual(f.persistedIds(), ['b', 'other']);
  assert.match(messages.at(-1)[1], /1 added.*0 duplicate.*0 enrichment.*1 Anki/i);
});

test('short addNotes response does not remove items without returned IDs', async () => {
  const f = fixture(); f.client.addNotes = async () => [123];
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(f.persistedIds(), ['b']);
});

test('saving a restored ID collision in one file cannot remove the other file entry', async () => {
  const f = fixture([chunk('a'), chunk('a', { uri: 'file:///other.md', context: 'Other file context.' })]);
  const otherBefore = f.queue.list('file:///other.md')[0];
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.equal(f.client.addedNotes.length, 1);
  assert.deepEqual(f.queue.list(), [otherBefore]);
  assert.notEqual(otherBefore.id, 'a');
  assert.deepEqual(f.persistedIds(), [otherBefore.id]);
});

for (const [locale, expected] of [
  ['en', /Anki confirmed 2 additions.*queue could not.*remain visible.*retry.*duplicate/i],
  ['vi', /Anki.*2.*hàng đợi.*hiển thị.*thử lại.*trùng/i],
  ['ja', /Anki.*2.*キュー.*表示.*再試行.*重複/],
]) {
  test(`queue commit failure reports only a local reconciliation message in ${locale}`, async () => {
    settings.set('uiLanguage', locale);
    const f = fixture(undefined, async () => { throw new Error('REMOTE PROSE synthetic-secret'); });
    await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
    assert.deepEqual(f.persistedIds(), ['a', 'b']);
    assert.deepEqual(f.queue.list(uri).map((item) => item.id), ['a', 'b']);
    assert.equal(f.client.addedNotes.length, 2);
    assert.equal(messages.length, 1, 'do not show the normal completion summary or generic API recovery');
    assert.equal(messages[0][0], 'error');
    assert.equal(messages[0].length, 2, 'local queue failure does not offer API/log actions');
    assert.match(messages[0][1], expected);
    assert.doesNotMatch(JSON.stringify({ messages, logs }), /REMOTE PROSE|synthetic-secret|\{count\}/);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const commitFails of [false, true]) {
  test(`confirmed IDs commit outside cancellable progress while another queue mutation blocks persistence${commitFails ? ', and persistence errors stay visible' : ''}`, async () => {
    const blockingWrite = deferred(), priorWriteStarted = deferred(), removalRequested = deferred();
    let writes = 0, progressAtCommit;
    const f = fixture([chunk('a'), chunk('b'), chunk('other', { uri: 'file:///other.md' })], async () => {
      if (++writes === 1) { priorWriteStarted.resolve(); await blockingWrite.promise; }
      else if (commitFails) throw new CancellationError('storage cancelled independently of progress');
    });
    const priorMutation = f.queue.remove('other');
    await priorWriteStarted.promise;
    const removeMany = f.queue.removeMany.bind(f.queue);
    f.queue.removeMany = (ids) => {
      progressAtCommit = progressActive;
      const commit = removeMany(ids);
      removalRequested.resolve();
      return commit;
    };
    f.client.addNotes = async (notes) => { f.client.addedNotes = notes; return [123, null]; };
    let saveFinished = false;
    const save = saveQueuedChunksToAnki(context, f.queue, uri, f.deps).then(() => { saveFinished = true; });
    await removalRequested.promise;
    const finishedBeforeUnblocking = saveFinished;
    const idsBeforeUnblocking = f.persistedIds();
    token.isCancellationRequested = true;
    blockingWrite.resolve();
    await priorMutation;
    await save;
    assert.equal(progressAtCommit, false, 'the durable queue commit must begin after the cancellable progress ends');
    assert.equal(finishedBeforeUnblocking, false, 'saving must await the queued durable commit');
    assert.deepEqual(idsBeforeUnblocking, ['a', 'b', 'other']);
    assert.deepEqual(f.persistedIds(), commitFails ? ['a', 'b'] : ['b']);
    assert.deepEqual(f.queue.list(uri).map((item) => item.id), commitFails ? ['a', 'b'] : ['b']);
    assert.equal(messages.filter((entry) => entry[0] === 'error').length, commitFails ? 1 : 0);
    if (commitFails) {
      assert.equal(messages.length, 1);
      assert.match(messages[0][1], /Anki confirmed 1 additions.*queue could not.*remain visible/i);
    } else {
      assert.match(messages.at(-1)[1], /1 added.*0 duplicate.*0 enrichment.*1 Anki/i);
    }
  });
}

test('duplicate entries remain queued and only addable entries are sent once', async () => {
  const f = fixture();
  f.client.canAddNotes = async (notes) => { f.client.checks++; f.client.checkedNotes = notes; return [false, true]; };
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(f.client.addedNotes.map((note) => note.fields.Chunk), ['chunk b']);
  assert.equal(f.client.checks, 1); assert.equal(f.client.adds, 1);
  assert.deepEqual(f.persistedIds(), ['a']);
  assert.match(messages.at(-1)[1], /1 added.*1 duplicate.*0 enrichment.*0 Anki/i);
});

test('all duplicates skip addNotes and preserve the queue', async () => {
  const f = fixture(); f.client.canAddNotes = async () => [false, false];
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.equal(f.client.adds, 0);
  assert.deepEqual(f.persistedIds(), ['a', 'b']);
});

test('missing provider preserves the queue without contacting Anki', async () => {
  const f = fixture(); f.deps.createProvider = async () => undefined;
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.equal(f.deps.enrichCalls.length, 0); assert.equal(f.deps.clientCalls, 0);
  assert.deepEqual(f.persistedIds(), ['a', 'b']);
});

for (const kind of ['timeout', 'parse', 'auth']) {
  test(`total ${kind} LLM failure keeps everything queued and reports safe chunk recovery`, async () => {
    const f = fixture();
    f.deps.enrich = async () => { throw new LLMError('REMOTE PROSE synthetic-secret', false, kind, { provider: 'qwen', model: 'model-synthetic-secret' }); };
    await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
    assert.deepEqual(f.persistedIds(), ['a', 'b']);
    assert.equal(f.deps.clientCalls, 0);
    assert.doesNotMatch(JSON.stringify({ messages, logs }), /REMOTE PROSE|synthetic-secret|write less|2 tries/);
    assert.match(messages.find((entry) => entry[0] === 'error')[1], /Qwen.*\[REDACTED\]/);
    if (kind === 'timeout') assert.match(messages[0][1], /fewer chunks/);
    if (kind === 'parse') assert.match(messages[0][1], /chunk.*JSON/i);
  });
}

test('one LLM request per snapshot group runs under a single cancellable progress operation', async () => {
  const f = fixture([
    chunk('a'), chunk('b'), chunk('c', { targetLanguage: 'ja', level: 'N3' }),
    chunk('d', { nativeLanguage: 'ja' }), chunk('e', { level: 'B2' }), chunk('f', { style: 'formal' }),
  ]);
  settings.set('anki.deckPattern', 'Learn::{language}::{level}');
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(f.deps.providerCalls, [[context, uri]]);
  assert.deepEqual(f.deps.enrichCalls.map((items) => items.map((item) => item.id)), [['a', 'b'], ['c'], ['d'], ['e'], ['f']]);
  assert.equal(progressOptions.length, 1); assert.equal(progressOptions[0].cancellable, true);
  assert.deepEqual(f.client.addedNotes.map((note) => note.deckName), ['Learn::en::B1', 'Learn::en::B1', 'Learn::ja::N3', 'Learn::en::B1', 'Learn::en::B2', 'Learn::en::B1']);
  assert.deepEqual(f.client.createdDecks, ['Learn::en::B1', 'Learn::ja::N3', 'Learn::en::B2']);
  assert.deepEqual(f.persistedIds(), []);
});

test('only selected entries are enriched and removed', async () => {
  const f = fixture(); pick = (items) => items.slice(1);
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(f.deps.enrichCalls.map((items) => items.map((item) => item.id)), [['b']]);
  assert.deepEqual(f.persistedIds(), ['a']);
});

for (const stage of ['before enrichment', 'during enrichment', 'before addNotes']) {
  test(`cancellation ${stage} preserves all entries`, async () => {
    const f = fixture();
    if (stage === 'before enrichment') progressHook = () => { token.isCancellationRequested = true; };
    if (stage === 'during enrichment') f.deps.enrich = async () => { throw new CancellationError(); };
    if (stage === 'before addNotes') f.client.canAddNotes = async () => { token.isCancellationRequested = true; return [true, true]; };
    await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
    assert.deepEqual(f.persistedIds(), ['a', 'b']);
    if (stage === 'before enrichment') assert.equal(f.deps.enrichCalls.length, 0);
    if (stage === 'before addNotes') assert.equal(f.client.adds, 0);
    assert.equal(messages.length, 0);
  });
}

test('cancellation while addNotes is in flight still commits only confirmed IDs outside progress', async () => {
  const addStarted = deferred(), addResponse = deferred();
  const writes = [];
  const f = fixture([chunk('a'), chunk('b'), chunk('other', { uri: 'file:///other.md' })], async () => {
    writes.push({ progressActive, cancelled: token.isCancellationRequested });
  });
  f.client.addNotes = async (notes) => {
    f.client.addedNotes = notes;
    addStarted.resolve();
    return addResponse.promise;
  };
  const save = saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  await addStarted.promise;
  token.isCancellationRequested = true;
  addResponse.resolve([123, null]);
  await save;
  assert.deepEqual(writes, [{ progressActive: false, cancelled: true }]);
  assert.deepEqual(f.persistedIds(), ['b', 'other']);
  assert.deepEqual(f.queue.list().map((item) => item.id), ['b', 'other']);
  assert.match(messages.at(-1)[1], /1 added.*0 duplicate.*0 enrichment.*1 Anki/i);
});

test('hostile plain-text fields are escaped exactly once at the real Anki HTTP boundary', async (t) => {
  const hostileUri = { toString: () => 'file:///writing/%3Cimg%20src=x%20onerror=%22boom()%22%3E%26%27.md' };
  const f = fixture([chunk('a', {
    uri: hostileUri.toString(),
    chunk: '<img src=x onerror="boom(\'x\')"> & &lt;',
    context: '<iframe src="https://remote.invalid">\'&</iframe>',
  })]);
  f.deps.enrich = async () => ({ enriched: [enriched('a', {
    meaning: '<script>"&\'</script>', example: '<img src="https://remote.invalid"> &\'',
    note: '<a href="javascript:boom()">\'&</a>',
  })], failedIds: [] });
  const transmitted = [];
  t.mock.method(global, 'fetch', async (_url, init) => {
    const { action, params } = JSON.parse(init.body);
    if (action === 'canAddNotes' || action === 'addNotes') transmitted.push(params.notes[0].fields);
    const results = { version: 6, modelNames: ['OneWriter Chunk'], deckNames: ['OneWriter::en'], canAddNotes: [true], addNotes: [123] };
    assert.ok(action in results);
    return new Response(JSON.stringify({ result: results[action], error: null }));
  });
  f.deps.createClient = () => new AnkiClient();
  await saveQueuedChunksToAnki(context, f.queue, hostileUri, f.deps);
  assert.equal(transmitted.length, 2);
  for (const fields of transmitted) {
    assert.deepEqual(fields, {
      Chunk: '&lt;img src=x onerror=&quot;boom(&#39;x&#39;)&quot;&gt; &amp; &amp;lt;',
      Meaning: '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;',
      Context: '&lt;iframe src=&quot;https://remote.invalid&quot;&gt;&#39;&amp;&lt;/iframe&gt;',
      Corrected: '&lt;img src=&quot;https://remote.invalid&quot;&gt; &amp;&#39;',
      Note: '&lt;a href=&quot;javascript:boom()&quot;&gt;&#39;&amp;&lt;/a&gt;',
      Source: '&lt;img src=x onerror=&quot;boom()&quot;&gt;&amp;&#39;.md',
    });
    assert.doesNotMatch(Object.values(fields).join(''), /[<>"']/);
  }
  assert.deepEqual(f.persistedIds(), []);
  assert.doesNotMatch(JSON.stringify({ messages, logs }), /remote\.invalid|onerror|<script>/);
});

for (const stage of ['version', 'canAddNotes', 'addNotes']) {
  test(`Anki ${stage} failure preserves all entries and offers the existing offline guide`, async () => {
    const f = fixture(); f.client[stage] = async () => { throw new AnkiError('Anki unavailable', true); };
    await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
    assert.deepEqual(f.persistedIds(), ['a', 'b']);
    const error = messages.find((entry) => entry[0] === 'error');
    assert.match(error[1], /Cannot reach Anki.*AnkiConnect/);
    assert.deepEqual(error.slice(2), ['Open guide']);
  });
}

test('real Anki response errors never expose remote prose or secrets in notifications or logs', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const actions = [];
  const results = { version: 6, modelNames: ['OneWriter Chunk'], deckNames: ['OneWriter::en'], canAddNotes: [true, true] };
  global.fetch = async (_url, init) => {
    const { action } = JSON.parse(init.body);
    actions.push(action);
    return new Response(JSON.stringify(action === 'addNotes'
      ? { result: null, error: 'HOSTILE REMOTE PROSE synthetic-secret private essay text' }
      : { result: results[action], error: null }));
  };
  const f = fixture();
  f.deps.createClient = () => new AnkiClient();
  await saveQueuedChunksToAnki(context, f.queue, uri, f.deps);
  assert.deepEqual(actions, ['version', 'modelNames', 'deckNames', 'canAddNotes', 'addNotes']);
  assert.deepEqual(f.persistedIds(), ['a', 'b']);
  const error = messages.find((entry) => entry[0] === 'error');
  assert.match(error[1], /Saving to Anki failed/);
  assert.doesNotMatch(JSON.stringify({ messages, logs }), /HOSTILE REMOTE PROSE|synthetic-secret|private essay text/);
  assert.match(messages.at(-1)[1], /0 added.*0 duplicate.*0 enrichment.*2 Anki/i);
});
