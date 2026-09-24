const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const { renderFrontMatterDetails, installFrontMatterPreview } = loadTs('src/markdown/preview.ts');

const source = `---
lang: ja
level: N2
style: polite
topic: một ngày làm việc của tôi
date: 2026-09-10
----------------

本文です。`;

test('preview front matter is a closed details block summarized only by topic', () => {
  const rendered = renderFrontMatterDetails(source);

  assert.ok(rendered);
  assert.match(rendered.html, /^<details class="onewriter-frontmatter">/);
  assert.match(rendered.html, /<summary>một ngày làm việc của tôi<\/summary>/);
  assert.doesNotMatch(rendered.html, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(rendered.html, /<th>lang<\/th><td>ja<\/td>/);
  assert.match(rendered.html, /<th>level<\/th><td>N2<\/td>/);
  assert.equal(rendered.endOffset, source.indexOf('\n\n本文') + 1);
});

test('preview escapes topic, keys and values before producing HTML', () => {
  const rendered = renderFrontMatterDetails(`---
topic: <img src=x onerror=alert(1)>
note<script>: A & B
---
body`);

  assert.ok(rendered);
  assert.doesNotMatch(rendered.html, /<img|<script>/);
  assert.match(rendered.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered.html, /note&lt;script&gt;/);
  assert.match(rendered.html, /A &amp; B/);
});

test('missing topic uses the non-empty OneWriter fallback', () => {
  const rendered = renderFrontMatterDetails('---\nlang: en\n---\nText');
  assert.match(rendered.html, /<summary>OneWriter<\/summary>/);
});

for (const value of [
  '# Normal markdown\n\nText',
  'Intro\n---\ntopic: nested\n---\nText',
  '---\ntopic: never closed\nText',
  '---\nnot metadata\n---\nText',
  '---\nlang: ja\nbroken line\n---\nText',
  '---\n: missing key\n---\nText',
]) {
  test('preview leaves non-OneWriter front matter untouched', () => {
    assert.equal(renderFrontMatterDetails(value), undefined);
  });
}

test('markdown-it plugin consumes only the leading front matter as one HTML block', () => {
  let rule;
  const md = {
    block: { ruler: { before: (anchor, name, callback, options) => {
      assert.equal(anchor, 'fence');
      assert.equal(name, 'onewriter_front_matter');
      assert.deepEqual(options.alt, ['paragraph', 'reference', 'blockquote', 'list']);
      rule = callback;
    } } },
  };
  assert.equal(installFrontMatterPreview(md), md);

  const tokens = [];
  const lines = source.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const state = {
    src: source, line: 0, lineMax: lines.length,
    bMarks: starts, tShift: lines.map(() => 0),
    push: (type, tag, nesting) => {
      const token = { type, tag, nesting, content: '', map: undefined };
      tokens.push(token);
      return token;
    },
  };

  assert.equal(rule(state, 0, lines.length, false), true);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, 'html_block');
  assert.match(tokens[0].content, /<summary>một ngày/);
  assert.equal(state.line, 7);
});

test('markdown-it plugin advances past a closing delimiter at end of file', () => {
  let rule;
  const md = { block: { ruler: { before: (_anchor, _name, callback) => { rule = callback; } } } };
  installFrontMatterPreview(md);
  const eofSource = '---\ntopic: End\n---';
  const tokens = [];
  const state = {
    src: eofSource, line: 0, lineMax: 3,
    bMarks: [0, 4, 15], tShift: [0, 0, 0],
    push: (type) => {
      const token = { type, content: '', map: undefined };
      tokens.push(token);
      return token;
    },
  };

  assert.equal(rule(state, 0, 3, false), true);
  assert.equal(state.line, 3);
  assert.equal(tokens.length, 1);
});

test('OneWriter rule runs before VS Code built-in YAML front matter', () => {
  const rules = [
    { name: 'fence', callback: () => false },
    { name: 'hr', callback: () => false },
  ];
  const md = { block: { ruler: { before: (anchor, name, callback) => {
    const index = rules.findIndex((entry) => entry.name === anchor);
    rules.splice(index, 0, { name, callback });
  } } } };
  installFrontMatterPreview(md);
  // Markdown's built-in contribution is installed after extension plugins.
  md.block.ruler.before('fence', 'front_matter', () => true);

  const state = {
    src: source,
    line: 0,
    bMarks: [0],
    tShift: [0],
    push: () => ({ content: '' }),
  };
  const winner = rules.find((entry) => entry.callback(state, 0, 8, true));
  assert.equal(winner?.name, 'onewriter_front_matter');
});
