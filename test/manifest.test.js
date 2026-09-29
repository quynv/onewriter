const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const localeFiles = ['package.nls.json', 'package.nls.vi.json', 'package.nls.ja.json'];
const LEGACY_README_SETUP = /codex exec|--skip-git-repo-check|onewriter\.llm\.cliCommand|onewriter\.llm\.cliCwd|\btrusted[- ](?:directory|workspace)\b|(?:\b(?:install|login|log in)\b|(?:cài(?: đặt)?|đăng nhập))[^\n]{0,80}\bCLI\b|\bCLI\b[^\n]{0,80}(?:\b(?:install|login|log in)\b|(?:cài(?: đặt)?|đăng nhập))/i;

test('queue commands are localized and selection menu permits saved remote documents', () => {
  for (const command of ['addSelectionToChunks', 'removeQueuedChunk', 'clearCurrentFileChunks', 'cleanChunkQueue']) {
    const entries = manifest.contributes.commands.filter((entry) => entry.command === `onewriter.${command}`);
    assert.equal(entries.length, 1, command);
    assert.equal(entries[0].title, `%command.${command}%`);
    for (const file of localeFiles) {
      assert.ok(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))[`command.${command}`]);
    }
  }
  const menu = manifest.contributes.menus['editor/context']?.find((entry) => entry.command === 'onewriter.addSelectionToChunks');
  assert.ok(menu?.when.includes('editorHasSelection'));
  assert.ok(!menu.when.includes('onewriter.isPracticeFile'));
  const save = manifest.contributes.menus['editor/title'].find((entry) => entry.command === 'onewriter.saveToAnki');
  assert.ok(!save.when.includes('onewriter.hasReview'), 'selection queues are saveable before review');
});

test('the latest-review command is localized and available from the editor title', () => {
  const command = manifest.contributes.commands.find((entry) => entry.command === 'onewriter.showLastReview');
  assert.equal(command?.title, '%command.showLastReview%');
  for (const file of localeFiles) {
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))['command.showLastReview']);
  }
  const menu = manifest.contributes.menus['editor/title']
    .find((entry) => entry.command === 'onewriter.showLastReview');
  assert.match(menu?.when ?? '', /onewriter\.hasReview/);
});

test('source generation is localized and available from the editor title', () => {
  const command = manifest.contributes.commands.find((entry) => entry.command === 'onewriter.generateSource');
  assert.equal(command?.title, '%command.generateSource%');
  assert.ok(command?.icon);
  for (const file of localeFiles) {
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))['command.generateSource']);
  }
  const menu = manifest.contributes.menus['editor/title']
    .find((entry) => entry.command === 'onewriter.generateSource');
  assert.match(menu?.when ?? '', /onewriter\.isPracticeFile/);
});

test('the extension contributes its front matter renderer and preview styles to Markdown', () => {
  assert.equal(manifest.contributes['markdown.markdownItPlugins'], true);
  assert.deepEqual(manifest.contributes['markdown.previewStyles'], ['media/markdown-preview.css']);
  assert.equal(fs.existsSync(path.join(root, 'media/markdown-preview.css')), true);
});

test('every manifest localization placeholder resolves in every locale', () => {
  const placeholders = new Set(JSON.stringify(manifest).match(/%[^%]+%/g) ?? []);

  for (const localeFile of localeFiles) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, localeFile), 'utf8'));
    for (const placeholder of placeholders) {
      const key = placeholder.slice(1, -1);
      assert.ok(messages[key], `${localeFile} is missing ${key}`);
    }
  }
});

test('the API key command title is provider-neutral in every locale', () => {
  for (const localeFile of localeFiles) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, localeFile), 'utf8'));
    assert.doesNotMatch(messages['command.setApiKey'], /Anthropic/i);
  }
});

for (const providerId of ['gemini', 'openai', 'qwen', 'deepseek', 'claude']) {
  test(`${providerId} enum description resolves to translated text in every locale`, () => {
    const provider = manifest.contributes.configuration.properties['onewriter.llm.provider'];
    const description = provider.enumDescriptions[provider.enum.indexOf(providerId)];
    assert.match(description, /^%[^%]+%$/, 'provider descriptions must use manifest localization');
    const key = description.slice(1, -1);
    const english = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'))[key];
    for (const localeFile of localeFiles) {
      const translated = JSON.parse(fs.readFileSync(path.join(root, localeFile), 'utf8'))[key];
      assert.ok(typeof translated === 'string' && translated.trim(), `${localeFile} is missing ${key}`);
      assert.doesNotMatch(translated, /^%[^%]+%$/);
      if (localeFile !== 'package.nls.json') assert.notEqual(translated, english, `${localeFile} needs a translation for ${providerId}`);
    }
  });
}

test('a fresh installation uses Gemini REST and exposes no CLI settings', () => {
  const properties = manifest.contributes.configuration.properties;
  const provider = properties['onewriter.llm.provider'];

  assert.equal(provider.default, 'gemini');
  assert.deepEqual(provider.enum, ['gemini', 'openai', 'qwen', 'deepseek', 'claude']);
  assert.equal(properties['onewriter.llm.gemini.model'].default, 'gemini-3.8-flash');
  assert.equal(properties['onewriter.llm.openai.model'].default, 'gpt-5.6-luna');
  assert.equal(properties['onewriter.llm.qwen.model'].default, 'qwen3.8-max');
  assert.equal(properties['onewriter.llm.deepseek.model'].default, 'deepseek-v4-flash');
  assert.equal(properties['onewriter.llm.claude.model'].default, 'claude-sonnet-4-6');
  assert.equal(
    properties['onewriter.llm.qwen.baseUrl'].default,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(properties['onewriter.llm.cliCommand'], undefined);
  assert.equal(properties['onewriter.llm.cliCwd'], undefined);
  assert.equal(properties['onewriter.llm.apiModel'], undefined);
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'onewriter.deleteApiKey'));
});

test('long writing reviews have a five-minute timeout by default', () => {
  const properties = manifest.contributes.configuration.properties;

  assert.equal(properties['onewriter.llm.timeoutMs'].default, 300000);
  assert.equal(properties['onewriter.llm.timeoutMs'].scope ?? 'window', 'window');
});

for (const setting of [
  'provider', 'gemini.model', 'openai.model', 'qwen.model', 'qwen.baseUrl',
  'deepseek.model', 'claude.model',
]) {
  test(`${setting} permits workspace-folder configuration`, () => {
    assert.equal(manifest.contributes.configuration.properties[`onewriter.llm.${setting}`].scope, 'resource');
  });
}

test('README documents REST provider setup without legacy CLI instructions', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  for (const required of [
    'Gemini', 'OpenAI', 'Qwen', 'DeepSeek', 'Claude', 'gemini-3.8-flash', 'SecretStorage',
    'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY',
    'ANTHROPIC_API_KEY', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'onewriter.setApiKey', 'onewriter.deleteApiKey',
  ]) {
    assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `README is missing ${required}`);
  }

  assert.doesNotMatch(readme, LEGACY_README_SETUP);
});

test('README legacy-setup guard recognizes Vietnamese CLI instructions', () => {
  for (const instruction of ['Cài CLI trước khi dùng.', 'Cài đặt CLI trước khi dùng.', 'Đăng nhập CLI trước khi dùng.']) {
    assert.match(instruction, LEGACY_README_SETUP);
  }
});

test('production source contains no LLM CLI execution path', () => {
  const source = fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(root, 'src', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /child_process|\bspawn\s*\(|CliProvider|assertNotCliError|unwrapCliEnvelope|llm\.cliCommand|llm\.cliCwd/);
  assert.equal(fs.existsSync(path.join(root, 'src/llm/cli.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/llm/api.ts')), false);
});
