const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const {
  buildSourcePrompt,
  composeReviewedDocument,
  isSafeGeneratedSource,
  parsePracticeBody,
  upsertSourceSection,
} = loadTs('src/practice/source.ts');
const { buildPrompt } = loadTs('src/llm/prompt.ts', {
  vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
});

const config = {
  nativeLanguage: 'vi', targetLanguage: 'ja', level: 'N2', style: 'polite',
  explanationLanguage: 'native', showBetter: true, maxChunks: 8,
  reviewMode: 'codelens', topic: 'một ngày làm việc của tôi',
};

test('a legacy body remains the complete review text', () => {
  const body = '私は毎朝七時に起きます。\n仕事へ行きます。';

  assert.deepEqual(parsePracticeBody(body), {
    writing: body,
    writingOffset: 0,
  });
});

test('a source exercise reviews only Writing and reports its exact body offset', () => {
  const body = [
    '## Source',
    '',
    'Tôi thức dậy lúc bảy giờ.',
    '',
    '## Writing',
    '',
    '私は七時に起きます。',
  ].join('\n');

  assert.deepEqual(parsePracticeBody(body), {
    source: 'Tôi thức dậy lúc bảy giờ.',
    writing: '私は七時に起きます。',
    writingOffset: body.indexOf('私は'),
  });
});

test('malformed or out-of-order headings stay on the legacy review path', () => {
  const body = '## Writing\n\nMy answer.\n\n## Source\n\nThe source.';

  assert.deepEqual(parsePracticeBody(body), {
    writing: body,
    writingOffset: 0,
  });
});

test('an empty Source does not enable content-fidelity review', () => {
  const body = '## Source\n\n\n## Writing\n\nMy learner answer is long enough.';

  assert.deepEqual(parsePracticeBody(body), {
    writing: body,
    writingOffset: 0,
  });
});

test('a populated Source with empty Writing remains source-aware so review reports too short', () => {
  const body = '## Source\n\nNội dung nguồn.\n\n## Writing\n\n';

  assert.deepEqual(parsePracticeBody(body), {
    source: 'Nội dung nguồn.',
    writing: '',
    writingOffset: body.length,
  });
});

test('inserting a generated source preserves an existing learner draft', () => {
  assert.equal(
    upsertSourceSection('私の下書きです。\n', 'Đây là nội dung mẫu.'),
    '## Source\n\nĐây là nội dung mẫu.\n\n## Writing\n\n私の下書きです。\n',
  );
});

test('regenerating a source replaces Source without changing Writing', () => {
  const body = '## Source\n\nCũ.\n\n## Writing\n\n私の文章。\n';

  assert.equal(
    upsertSourceSection(body, 'Nội dung mới.'),
    '## Source\n\nNội dung mới.\n\n## Writing\n\n私の文章。\n',
  );
});

test('diff content preserves front matter and Source while replacing only Writing', () => {
  const document = [
    '---', 'lang: ja', 'topic: 朝', '---', '',
    '## Source', '', 'Tôi thức dậy lúc bảy giờ.', '',
    '## Writing', '', '私は七時に起ます。',
  ].join('\n');

  assert.equal(composeReviewedDocument(document, '私は七時に起きます。'), [
    '---', 'lang: ja', 'topic: 朝', '---', '',
    '## Source', '', 'Tôi thức dậy lúc bảy giờ.', '',
    '## Writing', '', '私は七時に起きます。',
  ].join('\n'));
});

test('generated source rejects reserved section headings', () => {
  assert.equal(isSafeGeneratedSource('Một đoạn văn bình thường.'), true);
  assert.equal(isSafeGeneratedSource('Đoạn đầu.\n\n## Writing\n\nNội dung khác.'), false);
  assert.equal(isSafeGeneratedSource('## Source\n\nNội dung.'), false);
});

test('source generation prompt uses topic and native language while targeting the learner level', () => {
  const prompt = buildSourcePrompt(config);

  assert.match(prompt, /Vietnamese/);
  assert.match(prompt, /một ngày làm việc của tôi/);
  assert.match(prompt, /Japanese/);
  assert.match(prompt, /N2/);
  assert.match(prompt, /polite/);
  assert.match(prompt, /only the source passage/i);
});

test('review prompt compares Writing with Source when a source is present', () => {
  const prompt = buildPrompt('私は七時に起きます。', config, 'Tôi thức dậy lúc bảy giờ.');

  assert.match(prompt, /SOURCE PASSAGE:/);
  assert.match(prompt, /Tôi thức dậy lúc bảy giờ/);
  assert.match(prompt, /missing.*meaning|meaning.*missing/i);
  assert.match(prompt, /invented|unsupported/i);
});

test('review prompt stays on the original flow without a source', () => {
  const prompt = buildPrompt('私は七時に起きます。', config);

  assert.doesNotMatch(prompt, /SOURCE PASSAGE:/);
  assert.match(prompt, /LEARNER'S TEXT:/);
});
