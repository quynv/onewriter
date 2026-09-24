const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const settings = new Map();
const vscode = {
  workspace: {
    getConfiguration() {
      return {
        get(key, fallback) {
          return settings.has(key) ? settings.get(key) : fallback;
        },
      };
    },
  },
  languages: { match: () => 0 },
};

function loadConfigModule() {
  const entry = path.resolve(__dirname, '../src/config.ts');
  const output = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  }).outputFiles[0].text;

  const loaded = new Module(entry, module);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => (id === 'vscode' ? vscode : originalRequire(id));
  loaded._compile(output, entry);
  return loaded.exports;
}

const { resolveConfig, stripFrontMatter, deckName } = loadConfigModule();

test.beforeEach(() => {
  settings.clear();
  settings.set('targets', [{ language: 'en', level: 'B1', style: 'polite' }]);
  settings.set('activeTarget', 'en');
});

test('front matter language and level override configured targets', () => {
  const text = `---
lang: ja
level: N2
style: formal
topic: một ngày làm việc của tôi
date: 2026-09-10
----------------
今日は仕事について書きます。`;

  const resolved = resolveConfig({ getText: () => text });

  assert.equal(resolved.targetLanguage, 'ja');
  assert.equal(resolved.level, 'N2');
  assert.equal(resolved.style, 'formal');
  assert.equal(resolved.topic, 'một ngày làm việc của tôi');
  assert.equal(stripFrontMatter(text).body.trim(), '今日は仕事について書きます。');
});

test('missing front matter values fall back to the matching configured target', () => {
  settings.set('targets', [
    { language: 'en', level: 'B1', style: 'formal' },
    { language: 'ja', level: 'N3', style: 'plain' },
  ]);

  const resolved = resolveConfig({
    getText: () => '---\nlang: ja\n---\n本文',
  });

  assert.equal(resolved.targetLanguage, 'ja');
  assert.equal(resolved.level, 'N3');
  assert.equal(resolved.style, 'plain');
});

test('invalid front matter values fall back to settings', () => {
  settings.set('targets', [{ language: 'en', level: 'B2', style: 'formal' }]);

  const resolved = resolveConfig({
    getText: () => '---\nlang: unknown\nlevel: N2\nstyle: typo\n---\nText',
  });

  assert.equal(resolved.targetLanguage, 'en');
  assert.equal(resolved.level, 'B2');
  assert.equal(resolved.style, 'formal');
});

test('deck naming accepts a queued language/level snapshot independently of current targets', () => {
  settings.set('anki.deckPattern', 'OneWriter::{language}::{level}');
  assert.equal(deckName({ targetLanguage: 'ja', level: 'N3' }), 'OneWriter::ja::N3');
  assert.equal(deckName(resolveConfig({ getText: () => '---\nlang: ja\nlevel: N3\n---\n本文' })), 'OneWriter::ja::N3');
});
