const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');
const properties = require('../package.json').contributes.configuration.properties;

const values = new Map();
const explicit = new Map();
const folderValues = new Map();
const folderExplicit = new Map();
const updates = [];
const workspaceFolderUpdates = [];
const secrets = new Map();
const globalState = new Map();
let workspaceFolders;
let quickPickResult;
let inputResult;
let inputOptions;
let infoMessages;
let errorMessages;
let failStoreFor;

const targets = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

function reset() {
  values.clear();
  explicit.clear();
  folderValues.clear();
  folderExplicit.clear();
  updates.length = 0;
  workspaceFolderUpdates.length = 0;
  secrets.clear();
  globalState.clear();
  quickPickResult = undefined;
  inputResult = undefined;
  inputOptions = undefined;
  infoMessages = [];
  errorMessages = [];
  failStoreFor = undefined;
  workspaceFolders = undefined;
}

function inspect(key, resource) {
  const entries = explicit.get(key) ?? {};
  const folderEntries = resource ? folderExplicit.get(resource)?.get(key) : undefined;
  return {
    key: `onewriter.${key}`,
    defaultValue: undefined,
    globalValue: entries.global,
    workspaceValue: entries.workspace,
    workspaceFolderValue: folderEntries ?? entries.workspaceFolder,
  };
}

function configuration(resource) {
  return {
    get: (key, fallback) => {
      const folderValue = resource ? folderValues.get(resource)?.get(key) : undefined;
      return folderValue ?? (values.has(key) ? values.get(key) : fallback);
    },
    inspect: (key) => inspect(key, resource),
    update: async (key, value, target) => {
      if (target === targets.WorkspaceFolder) {
        if (!resource) {
          throw new Error('WorkspaceFolder updates require a scoped resource');
        }
        if (properties[`onewriter.${key}`]?.scope !== 'resource') {
          throw new Error(`WorkspaceFolder cannot update window-scoped setting ${key}`);
        }
        if (!folderValues.has(resource)) folderValues.set(resource, new Map());
        folderValues.get(resource).set(key, value);
        if (!folderExplicit.has(resource)) folderExplicit.set(resource, new Map());
        folderExplicit.get(resource).set(key, value);
        workspaceFolderUpdates.push({ key, value, resource });
      } else {
        values.set(key, value);
        const entries = explicit.get(key) ?? {};
        if (target === targets.Global) entries.global = value;
        if (target === targets.Workspace) entries.workspace = value;
        explicit.set(key, entries);
      }
      updates.push({ key, value, target });
    },
  };
}

function setFolder(folder, key, value) {
  if (!folderValues.has(folder)) folderValues.set(folder, new Map());
  folderValues.get(folder).set(key, value);
  if (!folderExplicit.has(folder)) folderExplicit.set(folder, new Map());
  folderExplicit.get(folder).set(key, value);
}

const vscode = {
  ConfigurationTarget: targets,
  workspace: {
    get workspaceFolders() {
      return workspaceFolders;
    },
    getConfiguration: (_section, resource) => configuration(resource),
  },
  window: {
    showQuickPick: async () => quickPickResult,
    showInputBox: async (options) => {
      inputOptions = options;
      return inputResult;
    },
    showInformationMessage: async (message) => infoMessages.push(message),
    showErrorMessage: async (message) => errorMessages.push(message),
  },
};

const context = {
  secrets: {
    get: async (key) => secrets.get(key),
    store: async (key, value) => {
      if (key === failStoreFor) throw new Error('simulated SecretStorage failure');
      secrets.set(key, value);
    },
    delete: async (key) => secrets.delete(key),
  },
  globalState: {
    get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
    update: async (key, value) => globalState.set(key, value),
  },
};

const {
  getApiKey,
  promptForApiKey,
  deleteApiKey,
  validateKey,
  migrateLegacyLlmConfig,
} = loadTs('src/llm/secrets.ts', { vscode });

test.beforeEach(reset);

test('configuration mock rejects workspace-folder writes to shared window settings', async () => {
  await assert.rejects(configuration('file:///workspace/folder').update(
    'llm.timeoutMs', 1000, targets.WorkspaceFolder,
  ), /cannot update window-scoped setting llm.timeoutMs/);
  assert.equal(updates.length, 0);
});

test('stored secret wins over environment fallback', async () => {
  process.env.GEMINI_API_KEY = 'environment-key';
  secrets.set('onewriter.apiKey.gemini', 'stored-key');
  assert.equal(await getApiKey(context, 'gemini'), 'stored-key');
  delete process.env.GEMINI_API_KEY;
});

test('set key trims and stores only the selected provider secret', async () => {
  quickPickResult = { value: 'deepseek' };
  inputResult = '  secret-value  ';
  assert.equal(await promptForApiKey(context), true);
  assert.equal(secrets.get('onewriter.apiKey.deepseek'), 'secret-value');
  assert.equal(values.has('apiKey'), false);
  assert.equal(inputOptions.password, true);
  assert.equal(inputOptions.ignoreFocusOut, true);
});

test('empty key is rejected without a provider-format assumption', () => {
  assert.equal(validateKey('   '), 'An API key is required.');
  assert.equal(validateKey('not-prefixed'), undefined);
});

test('delete removes only selected secret and reports environment fallback', async () => {
  secrets.set('onewriter.apiKey.gemini', 'gemini-secret');
  secrets.set('onewriter.apiKey.openai', 'openai-secret');
  process.env.GEMINI_API_KEY = 'environment-key';
  quickPickResult = { value: 'gemini' };

  assert.equal(await deleteApiKey(context), true);
  assert.equal(secrets.get('onewriter.apiKey.gemini'), undefined);
  assert.equal(secrets.get('onewriter.apiKey.openai'), 'openai-secret');
  assert.deepEqual(infoMessages, ['API key deleted. GEMINI_API_KEY is still available from the environment.']);
  delete process.env.GEMINI_API_KEY;
});

test('legacy api migrates to Claude without deleting rollback data', async () => {
  values.set('llm.provider', 'api');
  values.set('llm.apiModel', 'claude-custom');
  explicit.set('llm.provider', { global: 'api' });
  explicit.set('llm.apiModel', { global: 'claude-custom' });
  secrets.set('onewriter.anthropicApiKey', 'legacy-secret');

  await migrateLegacyLlmConfig(context);

  assert.equal(values.get('llm.provider'), 'claude');
  assert.equal(values.get('llm.claude.model'), 'claude-custom');
  assert.equal(secrets.get('onewriter.apiKey.claude'), 'legacy-secret');
  assert.equal(secrets.get('onewriter.anthropicApiKey'), 'legacy-secret');
  assert.equal(globalState.get('onewriter.llmMigrationVersion'), 1);
  assert.deepEqual(updates, [
    { key: 'llm.provider', value: 'claude', target: targets.Global },
    { key: 'llm.claude.model', value: 'claude-custom', target: targets.Global },
  ]);
});

test('legacy cli migrates to Gemini and retry preserves a newer key', async () => {
  values.set('llm.provider', 'cli');
  explicit.set('llm.provider', { workspace: 'cli' });
  secrets.set('onewriter.apiKey.claude', 'new-secret');
  await migrateLegacyLlmConfig(context);
  await migrateLegacyLlmConfig(context);
  assert.equal(values.get('llm.provider'), 'gemini');
  assert.equal(secrets.get('onewriter.apiKey.claude'), 'new-secret');
  assert.equal(globalState.get('onewriter.llmMigrationVersion'), 1);
  assert.deepEqual(updates, [{ key: 'llm.provider', value: 'gemini', target: targets.Workspace }]);
});

test('migration leaves its marker unset when SecretStorage store fails so retry can complete', async () => {
  values.set('llm.provider', 'api');
  explicit.set('llm.provider', { global: 'api' });
  secrets.set('onewriter.anthropicApiKey', 'legacy-secret');
  failStoreFor = 'onewriter.apiKey.claude';

  await assert.rejects(() => migrateLegacyLlmConfig(context), /simulated SecretStorage failure/);
  assert.equal(globalState.get('onewriter.llmMigrationVersion'), undefined);
  assert.equal(values.get('llm.provider'), 'api');

  failStoreFor = undefined;
  await migrateLegacyLlmConfig(context);
  assert.equal(values.get('llm.provider'), 'claude');
  assert.equal(globalState.get('onewriter.llmMigrationVersion'), 1);
});

test('a folder model does not suppress the broader legacy model needed by another folder', async () => {
  const folderA = 'file:///workspace/a';
  const folderB = 'file:///workspace/b';
  workspaceFolders = [{ uri: folderA }, { uri: folderB }];
  values.set('llm.provider', 'api');
  values.set('llm.apiModel', 'legacy-model');
  explicit.set('llm.provider', { global: 'api' });
  explicit.set('llm.apiModel', { global: 'legacy-model' });
  setFolder(folderA, 'llm.claude.model', 'folder-a-model');

  await migrateLegacyLlmConfig(context);

  assert.equal(values.get('llm.claude.model'), 'legacy-model');
  assert.equal(folderValues.get(folderA).get('llm.claude.model'), 'folder-a-model');
  assert.equal(folderValues.get(folderB)?.get('llm.claude.model'), undefined);
  assert.deepEqual(updates, [
    { key: 'llm.provider', value: 'claude', target: targets.Global },
    { key: 'llm.claude.model', value: 'legacy-model', target: targets.Global },
  ]);
});

test('migration reads and writes workspace-folder settings through that folder scope', async () => {
  const folder = 'file:///workspace/folder';
  workspaceFolders = [{ uri: folder }];
  setFolder(folder, 'llm.provider', 'api');
  setFolder(folder, 'llm.apiModel', 'folder-model');

  await migrateLegacyLlmConfig(context);

  assert.equal(folderValues.get(folder).get('llm.provider'), 'claude');
  assert.equal(folderValues.get(folder).get('llm.claude.model'), 'folder-model');
  assert.deepEqual(workspaceFolderUpdates, [
    { key: 'llm.provider', value: 'claude', resource: folder },
    { key: 'llm.claude.model', value: 'folder-model', resource: folder },
  ]);
});

test('migration still scans workspace and folders after the global marker is set', async () => {
  const folder = 'file:///workspace/later';
  workspaceFolders = [{ uri: folder }];
  globalState.set('onewriter.llmMigrationVersion', 1);
  values.set('llm.provider', 'cli');
  explicit.set('llm.provider', { workspace: 'cli' });
  setFolder(folder, 'llm.provider', 'api');

  await migrateLegacyLlmConfig(context);

  assert.equal(values.get('llm.provider'), 'gemini');
  assert.equal(folderValues.get(folder).get('llm.provider'), 'claude');
  assert.deepEqual(updates, [
    { key: 'llm.provider', value: 'gemini', target: targets.Workspace },
    { key: 'llm.provider', value: 'claude', target: targets.WorkspaceFolder },
  ]);
  assert.deepEqual(workspaceFolderUpdates, [
    { key: 'llm.provider', value: 'claude', resource: folder },
  ]);
});
