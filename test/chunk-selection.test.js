const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const {
  ChunkSelectionError,
  extractChunkSelection,
  normalizeChunk,
} = loadTs('src/chunks/selection.ts');

test('normalizes formatting whitespace and NFC without lowercasing', () => {
  assert.equal(normalizeChunk('  Café\n  AU  lait '), 'Café AU lait');
  assert.equal(normalizeChunk('Cafe\u0301'), 'Café');
});

test('extracts the English sentence containing the selection', () => {
  const text = 'First sentence. I look forward to Friday! Last one.';
  const start = text.indexOf('look forward to');
  assert.deepEqual(extractChunkSelection(text, start, start + 15), {
    chunk: 'look forward to', context: 'I look forward to Friday!',
  });
});

test('does not expand past a terminator included at the selection end', () => {
  const text = 'First sentence. Next sentence.';
  const end = 'First sentence.'.length;
  assert.deepEqual(extractChunkSelection(text, 0, end), {
    chunk: 'First sentence.', context: 'First sentence.',
  });
});

test('selecting First sentence. plus trailing whitespace never captures Next sentence.', () => {
  const text = 'First sentence. Next sentence.';
  assert.deepEqual(extractChunkSelection(text, 0, 'First sentence. '.length), {
    chunk: 'First sentence.', context: 'First sentence.',
  });
});

test('sentence boundaries ignore selected leading and trailing whitespace with reversed offsets', () => {
  const text = 'Previous sentence.\n\n  First sentence. \n\nNext sentence.';
  assert.deepEqual(extractChunkSelection(text, text.indexOf('Next'), 'Previous sentence.'.length), {
    chunk: 'First sentence.', context: 'First sentence.',
  });
});

test('extracts Japanese context without requiring spaces', () => {
  const text = '朝ご飯を食べた。電車で本を読むよう心掛けている。仕事を始める。';
  const start = text.indexOf('心掛けている');
  assert.deepEqual(extractChunkSelection(text, start, start + '心掛けている'.length), {
    chunk: '心掛けている', context: '電車で本を読むよう心掛けている。',
  });
});

test('falls back to the containing paragraph when no sentence boundary exists', () => {
  const text = 'A useful phrase\ncontinues on the next line\nwithout a terminator';
  const start = text.indexOf('continues');
  assert.deepEqual(extractChunkSelection(text, start, start + 9), {
    chunk: 'continues', context: 'A useful phrase continues on the next line without a terminator',
  });
});

test('normalizes a selection crossing a line break', () => {
  const text = 'Please look\nforward to this. Next.';
  const start = text.indexOf('look');
  assert.deepEqual(extractChunkSelection(text, start, text.indexOf('this')), {
    chunk: 'look forward to', context: 'Please look forward to this.',
  });
});

test('orders reversed offsets and clamps them to the text', () => {
  const text = 'Keep this phrase.';
  assert.deepEqual(extractChunkSelection(text, 16, -10), {
    chunk: 'Keep this phrase', context: 'Keep this phrase.',
  });
});

test('rejects an all-whitespace selection', () => {
  assert.throws(() => extractChunkSelection('before   after', 6, 9), (error) => {
    assert.ok(error instanceof ChunkSelectionError);
    assert.equal(error.kind, 'empty');
    return true;
  });
});

test('rejects selections longer than 200 Unicode code points', () => {
  const text = '😀'.repeat(201);
  assert.throws(() => extractChunkSelection(text, 0, text.length), (error) => {
    assert.ok(error instanceof ChunkSelectionError);
    assert.equal(error.kind, 'tooLong');
    return true;
  });
});
