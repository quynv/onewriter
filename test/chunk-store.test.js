const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const STORAGE_KEY = 'onewriter.chunkQueue.v1';

function input(overrides = {}) {
  return {
    uri: 'file:///a.md',
    chunk: 'look forward to',
    context: 'I look forward to Friday.',
    targetLanguage: 'en',
    nativeLanguage: 'vi',
    level: 'B1',
    style: 'plain',
    source: 'selection',
    ...overrides,
  };
}

function queueItem(overrides = {}) {
  return {
    id: 'existing-id',
    uri: 'file:///a.md',
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

function createMemento(initial, { failUpdate = false, blockFirstUpdate = false } = {}) {
  const values = new Map(
    initial === undefined ? [] : [[STORAGE_KEY, structuredClone(initial)]],
  );
  const writes = [];
  const reads = [];
  let firstUpdateBlocked = false;
  let signalFirstUpdateStarted;
  let releaseFirstUpdate;
  const firstUpdateStarted = new Promise((resolve) => { signalFirstUpdateStarted = resolve; });
  return {
    get: (key) => {
      reads.push(key);
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    update: async (key, next) => {
      if (failUpdate) throw new Error('disk full');
      if (blockFirstUpdate && !firstUpdateBlocked) {
        firstUpdateBlocked = true;
        signalFirstUpdateStarted();
        await new Promise((resolve) => { releaseFirstUpdate = resolve; });
      }
      writes.push({ key, value: structuredClone(next) });
      values.set(key, structuredClone(next));
    },
    writes,
    reads,
    firstUpdateStarted,
    releaseFirstUpdate: () => releaseFirstUpdate(),
  };
}

function createVscode(stat = async () => ({})) {
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }

    fire(value) {
      for (const listener of this.listeners) listener(value);
    }

    dispose() {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter,
    Uri: { parse: (value) => ({ toString: () => value }) },
    workspace: { fs: { stat } },
  };
}

function loadStore(vscode = createVscode()) {
  return loadTs('src/chunks/store.ts', { vscode });
}

test('persists an added normalized chunk and rejects its duplicate in the same file', async () => {
  const { ChunkQueueStore } = loadStore();
  const memento = createMemento();
  const store = new ChunkQueueStore(memento);

  assert.deepEqual(memento.reads, [STORAGE_KEY]);

  const first = await store.add(input({ uri: 'file:///a.md', chunk: 'look forward to' }));
  const duplicate = await store.add(input({ uri: 'file:///a.md', chunk: ' look\nforward to ' }));

  assert.equal(first.status, 'added');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(store.list('file:///a.md').length, 1);
  assert.deepEqual(memento.writes[0], {
    key: STORAGE_KEY,
    value: { version: 1, items: [first.item] },
  });

  const restored = new ChunkQueueStore(memento);
  assert.equal(restored.list('file:///a.md')[0].chunk, 'look forward to');
  assert.deepEqual(memento.reads, [STORAGE_KEY, STORAGE_KEY]);
});

test('serializes concurrent additions so neither successful write is lost', async () => {
  const { ChunkQueueStore } = loadStore();
  const memento = createMemento(undefined, { blockFirstUpdate: true });
  const store = new ChunkQueueStore(memento);

  const first = store.add(input({ chunk: 'first' }));
  await memento.firstUpdateStarted;
  const second = store.add(input({ chunk: 'second' }));
  memento.releaseFirstUpdate();
  await Promise.all([first, second]);

  assert.deepEqual(store.list().map((item) => item.chunk).sort(), ['first', 'second']);
});

test('allows the same normalized chunk in a different file', async () => {
  const { ChunkQueueStore } = loadStore();
  const store = new ChunkQueueStore(createMemento());

  await store.add(input({ uri: 'file:///a.md' }));
  const second = await store.add(input({ uri: 'file:///b.md', chunk: ' look\nforward to ' }));

  assert.equal(second.status, 'added');
  assert.equal(store.list().length, 2);
  assert.equal(store.list('file:///b.md')[0].normalizedChunk, 'look forward to');
});

test('removeMany removes only entries with exact requested IDs', async () => {
  const { ChunkQueueStore } = loadStore();
  const store = new ChunkQueueStore(createMemento());
  const first = await store.add(input({ chunk: 'first' }));
  const second = await store.add(input({ chunk: 'second' }));
  const third = await store.add(input({ chunk: 'third' }));

  assert.equal(await store.removeMany(new Set([first.item.id, third.item.id, 'not-an-id'])), 2);
  assert.deepEqual(store.list().map((item) => item.id), [second.item.id]);
});

test('clear removes entries for one file only', async () => {
  const { ChunkQueueStore } = loadStore();
  const store = new ChunkQueueStore(createMemento());
  await store.add(input({ uri: 'file:///a.md', chunk: 'first' }));
  await store.add(input({ uri: 'file:///b.md', chunk: 'second' }));

  assert.equal(await store.clear('file:///a.md'), 1);
  assert.equal(store.list('file:///a.md').length, 0);
  assert.equal(store.list('file:///b.md').length, 1);
});

test('does not alter the in-memory queue when persistence fails', async () => {
  const { ChunkQueueStore } = loadStore();
  const store = new ChunkQueueStore(createMemento(undefined, { failUpdate: true }));

  await assert.rejects(store.add(input()), /disk full/);
  assert.equal(store.list().length, 0);
});

test('ignores malformed version-one records while retaining valid records', () => {
  const { ChunkQueueStore } = loadStore();
  const memento = createMemento({
    version: 1,
    items: [queueItem(), { id: 'bad', uri: 'file:///bad.md' }, null],
  });
  const store = new ChunkQueueStore(memento);

  assert.deepEqual(store.list(), [queueItem()]);
});

test('restoration rekeys empty and colliding IDs without dropping payloads or writing until a normal mutation', async () => {
  const { ChunkQueueStore } = loadStore();
  const records = [
    queueItem(),
    queueItem({ uri: 'file:///b.md', chunk: 'second payload', context: 'Second context.' }),
    queueItem({ id: '', uri: 'file:///empty.md', chunk: 'empty ID payload' }),
    queueItem({ id: '   ', uri: 'file:///blank.md', chunk: 'blank ID payload' }),
  ];
  const memento = createMemento({ version: 1, items: records });
  const store = new ChunkQueueStore(memento);
  const restored = store.list();
  assert.equal(restored[0].id, 'existing-id');
  assert.equal(new Set(restored.map((item) => item.id)).size, 4);
  for (const item of restored.slice(1)) assert.match(item.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.deepEqual(restored.map(({ id, ...payload }) => payload), records.map(({ id, ...payload }) => payload));
  assert.equal(memento.writes.length, 0);
  assert.deepEqual(memento.get(STORAGE_KEY).items, records);
  await store.add(input({ uri: 'file:///new.md', chunk: 'next normal write' }));
  assert.deepEqual(memento.writes[0].value.items.slice(0, 4), restored);
  assert.deepEqual(new ChunkQueueStore(memento).list().slice(0, 4), restored);
  await store.remove('existing-id');
  assert.equal(store.list('file:///b.md')[0].id, restored[1].id);
});

test('generated restoration IDs cannot steal a later existing non-empty ID', (t) => {
  const { ChunkQueueStore } = loadStore();
  const reserved = 'bb28d425-06ba-46a7-bd7e-dd2906f34062';
  const fresh = 'db5a4636-70b2-4345-ae63-a356104262e8';
  const generated = [reserved, fresh];
  t.mock.method(global.crypto, 'randomUUID', () => generated.shift());
  const store = new ChunkQueueStore(createMemento({ version: 1, items: [
    queueItem({ id: '' }), queueItem({ id: reserved, uri: 'file:///later.md' }),
  ] }));
  assert.deepEqual(store.list().map((item) => item.id), [fresh, reserved]);
});

test('does not overwrite an unknown future queue envelope version', async () => {
  const { ChunkQueueStore, UnsupportedChunkQueueVersionError } = loadStore();
  const memento = createMemento({ version: 2, items: [queueItem()] });
  const store = new ChunkQueueStore(memento);

  assert.deepEqual(store.list(), []);
  await assert.rejects(store.add(input()), UnsupportedChunkQueueVersionError);
  await assert.rejects(store.addMany([input()]), UnsupportedChunkQueueVersionError);
  await assert.rejects(store.remove('existing-id'), UnsupportedChunkQueueVersionError);
  await assert.rejects(store.removeMany(new Set(['existing-id'])), UnsupportedChunkQueueVersionError);
  await assert.rejects(store.clear('file:///a.md'), UnsupportedChunkQueueVersionError);
  await assert.rejects(store.cleanDeleted(), UnsupportedChunkQueueVersionError);
  assert.equal(memento.writes.length, 0);
});

test('cleanDeleted removes only FileNotFound entries and persists and emits once', async () => {
  const missing = new Set(['file:///missing.md']);
  const denied = new Set(['file:///denied.md']);
  const vscode = createVscode(async (uri) => {
    const value = uri.toString();
    if (missing.has(value)) throw { code: 'FileNotFound' };
    if (denied.has(value)) throw { code: 'NoPermissions' };
    return {};
  });
  const { ChunkQueueStore } = loadStore(vscode);
  const memento = createMemento();
  const store = new ChunkQueueStore(memento);
  await store.add(input({ uri: 'file:///exists.md', chunk: 'exists' }));
  await store.add(input({ uri: 'file:///missing.md', chunk: 'missing one' }));
  await store.add(input({ uri: 'file:///missing.md', chunk: 'missing two' }));
  await store.add(input({ uri: 'file:///denied.md', chunk: 'denied' }));
  const writesBeforeCleanup = memento.writes.length;
  let changes = 0;
  store.onDidChange(() => { changes += 1; });

  assert.equal(await store.cleanDeleted(), 2);
  assert.equal(store.list('file:///missing.md').length, 0);
  assert.equal(store.list('file:///exists.md').length, 1);
  assert.equal(store.list('file:///denied.md').length, 1);
  assert.equal(memento.writes.length, writesBeforeCleanup + 1);
  assert.equal(changes, 1);
  assert.equal(await store.cleanDeleted(), 0);
  assert.equal(memento.writes.length, writesBeforeCleanup + 1);
  assert.equal(changes, 1);
});
