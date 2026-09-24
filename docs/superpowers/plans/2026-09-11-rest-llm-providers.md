# REST LLM Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OneWriter's CLI/Anthropic-only review path with secure direct REST integrations for Gemini, OpenAI, Qwen, DeepSeek, and Claude, defaulting to Gemini.

**Architecture:** Keep `LLMProvider.complete()` as the review boundary, but construct one of five focused REST adapters from provider metadata and secrets. Share timeout/cancellation and sanitized HTTP errors in one transport, keep SecretStorage and idempotent legacy migration in one module, and preserve the existing prompt/parser/normalizer pipeline.

**Tech Stack:** TypeScript, VS Code Extension API, built-in `fetch`/`AbortController`, Node test runner, esbuild test bundling

**Spec:** `docs/superpowers/specs/2026-09-11-rest-llm-providers-design.md`

## Global Constraints

- No vendor SDK or new runtime dependency.
- `onewriter.llm.provider` supports exactly `gemini | openai | qwen | deepseek | claude` and defaults to `gemini`.
- Gemini defaults to `gemini-3.8-flash`.
- Keys entered through OneWriter are stored only in VS Code SecretStorage.
- SecretStorage values take precedence over environment variables.
- Do not log keys, authorization headers, request bodies, or complete remote error bodies.
- Keep `onewriter.llm.timeoutMs` at `300000` by default and preserve user cancellation.
- Preserve valid document front matter `lang` and `level` precedence over Settings.
- Preserve the legacy Anthropic secret and old configuration values for rollback.
- This directory currently has no Git metadata. Run each listed commit step only after the repository is initialized or restored as a Git worktree.

---

## File Structure

**Create:**

- `src/llm/providers/types.ts` — provider union, metadata, endpoints, setting keys, secret IDs, and environment-variable names.
- `src/llm/schema.ts` — provider-neutral JSON Schema for `ReviewResult`.
- `src/llm/secrets.ts` — provider-aware secret commands, lookup precedence, and legacy migration.
- `src/llm/http.ts` — JSON POST transport, timeout/cancellation, error sanitization, and response classification.
- `src/llm/providers/gemini.ts` — native Gemini request and response extraction.
- `src/llm/providers/openai.ts` — native OpenAI Responses request and response extraction.
- `src/llm/providers/openai-compatible.ts` — shared Qwen/DeepSeek chat-completions serialization and extraction.
- `src/llm/providers/qwen.ts` — Qwen endpoint configuration and adapter construction.
- `src/llm/providers/deepseek.ts` — DeepSeek endpoint configuration and adapter construction.
- `src/llm/providers/claude.ts` — native Claude Messages request and response extraction.
- `test/helpers/load-ts.js` — compile a TypeScript entry with esbuild and inject a VS Code mock.
- `test/llm-metadata.test.js` — provider metadata/schema tests.
- `test/llm-secrets.test.js` — secret precedence, commands, and migration tests.
- `test/llm-http.test.js` — transport, cancellation, timeout, sanitization, and status mapping tests.
- `test/llm-providers.test.js` — request/response contract tests for all providers.
- `test/llm-factory.test.js` — provider construction, missing-key flow, and review retry tests.

**Modify:**

- `src/types.ts` — type `LLMProvider.name` with the provider union.
- `src/llm/provider.ts` — replace CLI/API branching with the five-provider factory.
- `src/llm/errors.ts` — remove CLI envelopes and expand error kinds.
- `src/review/controller.ts` — remove terminal/login actions and report provider-aware REST failures.
- `src/extension.ts` — run migration and register set/delete key commands.
- `src/ui/sidebar.ts` — show provider and its provider-specific model.
- `src/i18n.ts` — provider-aware commands and errors in runtime English/Vietnamese/Japanese bundles.
- `package.json` — replace CLI/API settings, add five model settings and the delete-key command.
- `package.nls.json`, `package.nls.vi.json`, `package.nls.ja.json` — localize manifest additions/removals.
- `test/manifest.test.js` — assert API-only manifest and Gemini defaults.
- `README.md` — document five REST providers and secure key setup.

**Delete after all replacement tests pass:**

- `src/llm/cli.ts`
- `src/llm/api.ts`

---

### Task 1: Provider Metadata, Review Schema, and Manifest Contract

**Files:**
- Create: `test/helpers/load-ts.js`
- Create: `test/llm-metadata.test.js`
- Create: `src/llm/providers/types.ts`
- Create: `src/llm/schema.ts`
- Modify: `src/types.ts`
- Modify: `test/manifest.test.js`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.vi.json`
- Modify: `package.nls.ja.json`

**Interfaces:**
- Produces: `LLM_PROVIDER_IDS`, `LLMProviderId`, `ProviderDefinition`, `PROVIDERS`, `isProviderId`, `getProviderModel`, and `REVIEW_JSON_SCHEMA`.
- Consumes: existing `LLMProvider`, `ReviewResult`, and VS Code workspace configuration.

- [ ] **Step 1: Add failing manifest assertions**

Replace the CLI-default test in `test/manifest.test.js` with exact assertions:

```js
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
```

- [ ] **Step 2: Run the manifest test and verify it fails**

Run: `node --test test/manifest.test.js`
Expected: FAIL because the manifest still defaults to `cli` and contains the legacy settings.

- [ ] **Step 3: Add provider metadata and schema tests**

Create `test/helpers/load-ts.js` with a reusable esbuild loader based on the existing `test/config.test.js` pattern:

```js
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

function loadTs(relativeEntry, mocks = {}) {
  const entry = path.resolve(__dirname, '../..', relativeEntry);
  const code = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: Object.keys(mocks),
  }).outputFiles[0].text;
  const loaded = new Module(entry, module);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => (id in mocks ? mocks[id] : originalRequire(id));
  loaded._compile(code, entry);
  return loaded.exports;
}

module.exports = { loadTs };
```

Create `test/llm-metadata.test.js` to assert the exact five IDs, secret IDs, environment names, default models, and required top-level schema properties:

```js
test('provider definitions are complete and Gemini is the default', () => {
  assert.deepEqual(LLM_PROVIDER_IDS, ['gemini', 'openai', 'qwen', 'deepseek', 'claude']);
  assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-3.8-flash');
  assert.equal(PROVIDERS.gemini.secretId, 'onewriter.apiKey.gemini');
  assert.equal(PROVIDERS.qwen.environmentVariable, 'DASHSCOPE_API_KEY');
  assert.equal(PROVIDERS.claude.secretId, 'onewriter.apiKey.claude');
});

test('review schema requires the normalized result shape', () => {
  assert.deepEqual(REVIEW_JSON_SCHEMA.required, [
    'overallComment', 'rewritten', 'issues', 'chunks',
  ]);
  assert.equal(REVIEW_JSON_SCHEMA.additionalProperties, false);
  assert.equal(REVIEW_JSON_SCHEMA.properties.issues.type, 'array');
});
```

- [ ] **Step 4: Run metadata and manifest tests and verify they fail**

Run: `node --test test/manifest.test.js test/llm-metadata.test.js`
Expected: FAIL because provider metadata, schema, and new settings do not exist.

- [ ] **Step 5: Implement provider metadata and the shared schema**

Define the exact metadata contract in `src/llm/providers/types.ts`:

```ts
export const LLM_PROVIDER_IDS = ['gemini', 'openai', 'qwen', 'deepseek', 'claude'] as const;
export type LLMProviderId = (typeof LLM_PROVIDER_IDS)[number];

export interface ProviderDefinition {
  label: string;
  defaultModel: string;
  modelSetting: `llm.${LLMProviderId}.model`;
  secretId: `onewriter.apiKey.${LLMProviderId}`;
  environmentVariable: string;
}

export const PROVIDERS: Record<LLMProviderId, ProviderDefinition> = {
  gemini: { label: 'Gemini', defaultModel: 'gemini-3.8-flash', modelSetting: 'llm.gemini.model', secretId: 'onewriter.apiKey.gemini', environmentVariable: 'GEMINI_API_KEY' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-5.6-luna', modelSetting: 'llm.openai.model', secretId: 'onewriter.apiKey.openai', environmentVariable: 'OPENAI_API_KEY' },
  qwen: { label: 'Qwen', defaultModel: 'qwen3.8-max', modelSetting: 'llm.qwen.model', secretId: 'onewriter.apiKey.qwen', environmentVariable: 'DASHSCOPE_API_KEY' },
  deepseek: { label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', modelSetting: 'llm.deepseek.model', secretId: 'onewriter.apiKey.deepseek', environmentVariable: 'DEEPSEEK_API_KEY' },
  claude: { label: 'Claude', defaultModel: 'claude-sonnet-4-6', modelSetting: 'llm.claude.model', secretId: 'onewriter.apiKey.claude', environmentVariable: 'ANTHROPIC_API_KEY' },
};

export function isProviderId(value: unknown): value is LLMProviderId {
  return typeof value === 'string' && LLM_PROVIDER_IDS.includes(value as LLMProviderId);
}

export function getProviderModel(
  configuration: vscode.WorkspaceConfiguration,
  provider: LLMProviderId,
): string {
  const definition = PROVIDERS[provider];
  return configuration.get<string>(definition.modelSetting, definition.defaultModel);
}
```

Export a literal JSON Schema from `src/llm/schema.ts` with `additionalProperties: false`, the four required top-level fields, all issue/chunk fields and enums from `src/types.ts`, nullable optional string fields, and no runtime VS Code dependency.

Update `LLMProvider.name` in `src/types.ts` to `readonly name: LLMProviderId` and import the type from `src/llm/providers/types.ts` with `import type`.

- [ ] **Step 6: Replace the manifest settings and localization placeholders**

Set the five-value provider enum/default, add the five model settings and Qwen base URL, add `onewriter.deleteApiKey`, and remove `cliCommand`, `cliCwd`, and `apiModel`. Add exact matching descriptions and command titles to all three `package.nls*.json` files.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `node --test test/manifest.test.js test/llm-metadata.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit the metadata contract when Git is available**

```sh
git add package.json package.nls.json package.nls.vi.json package.nls.ja.json src/types.ts src/llm/schema.ts src/llm/providers/types.ts test/helpers/load-ts.js test/manifest.test.js test/llm-metadata.test.js
git commit -m "feat: define REST LLM providers"
```

---

### Task 2: SecretStorage Commands and Idempotent Legacy Migration

**Files:**
- Create: `src/llm/secrets.ts`
- Create: `test/llm-secrets.test.js`
- Modify: `src/extension.ts`
- Modify: `src/i18n.ts`

**Interfaces:**
- Consumes: `LLMProviderId`, `PROVIDERS`, `vscode.ExtensionContext`, and workspace configuration.
- Produces: `getApiKey(context, provider)`, `promptForApiKey(context, initialProvider?)`, `deleteApiKey(context)`, and `migrateLegacyLlmConfig(context)`.

- [ ] **Step 1: Write failing secret precedence and command tests**

Create VS Code mocks for QuickPick, password input, SecretStorage, configuration `inspect/get/update`, and `globalState`. Assert these cases:

```js
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
  assert.equal(settings.has('apiKey'), false);
});

test('empty key is rejected without a provider-format assumption', async () => {
  assert.equal(validateKey('   '), translatedRequiredMessage);
  assert.equal(validateKey('not-prefixed'), undefined);
});
```

Also assert that delete removes only the selected SecretStorage value and reports an environment fallback when present.

- [ ] **Step 2: Write failing migration tests**

Cover both old providers and safe retries:

```js
test('legacy api migrates to Claude without deleting rollback data', async () => {
  settings.set('llm.provider', 'api');
  settings.set('llm.apiModel', 'claude-custom');
  secrets.set('onewriter.anthropicApiKey', 'legacy-secret');

  await migrateLegacyLlmConfig(context);

  assert.equal(settings.get('llm.provider'), 'claude');
  assert.equal(settings.get('llm.claude.model'), 'claude-custom');
  assert.equal(secrets.get('onewriter.apiKey.claude'), 'legacy-secret');
  assert.equal(secrets.get('onewriter.anthropicApiKey'), 'legacy-secret');
  assert.equal(globalState.get('onewriter.llmMigrationVersion'), 1);
});

test('legacy cli migrates to Gemini and retry preserves a newer key', async () => {
  settings.set('llm.provider', 'cli');
  secrets.set('onewriter.apiKey.claude', 'new-secret');
  await migrateLegacyLlmConfig(context);
  await migrateLegacyLlmConfig(context);
  assert.equal(settings.get('llm.provider'), 'gemini');
  assert.equal(secrets.get('onewriter.apiKey.claude'), 'new-secret');
});
```

Simulate a failed secret store and assert that the migration marker is not written, allowing a later retry.

- [ ] **Step 3: Run secret tests and verify they fail**

Run: `node --test test/llm-secrets.test.js`
Expected: FAIL because `src/llm/secrets.ts` does not exist.

- [ ] **Step 4: Implement secret lookup and commands**

Use these signatures:

```ts
export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: LLMProviderId,
): Promise<string | undefined>;

export async function promptForApiKey(
  context: vscode.ExtensionContext,
  initialProvider?: LLMProviderId,
): Promise<boolean>;

export async function deleteApiKey(context: vscode.ExtensionContext): Promise<boolean>;
```

Provider selection items carry `value: LLMProviderId`. The input uses `password: true`, `ignoreFocusOut: true`, and validation that rejects only an empty trimmed value. `getApiKey` returns `await context.secrets.get(secretId)` first and reads `process.env[environmentVariable]` only when storage is empty.

- [ ] **Step 5: Implement migration with expand–verify–record ordering**

Use `MIGRATION_KEY = 'onewriter.llmMigrationVersion'` and `MIGRATION_VERSION = 1`. Resolve explicit legacy settings in VS Code precedence order (`workspaceFolderValue`, `workspaceValue`, then `globalValue`) and retain the matching `ConfigurationTarget` for each write. Copy the legacy secret only if the new Claude secret is absent; read it back and compare before continuing. Update legacy `api` to `claude`, legacy `cli` to `gemini`, and copy an explicit old model only when the new Claude model is not explicitly set at an equal or higher-precedence scope. Write the global-state marker last. Never delete `onewriter.anthropicApiKey`.

- [ ] **Step 6: Register migration and secret commands at activation**

Change activation to `export async function activate(...): Promise<void>` and await `migrateLegacyLlmConfig(context)` before constructing controllers or registering review commands. Catch and sanitize a migration failure so activation can continue and the next activation can retry because no marker was written. Register:

```ts
vscode.commands.registerCommand('onewriter.setApiKey', () => promptForApiKey(context));
vscode.commands.registerCommand('onewriter.deleteApiKey', () => deleteApiKey(context));
```

Replace Anthropic-specific runtime strings in all three language maps with provider-aware selection, required-key, saved-key, deleted-key, environment-fallback, and migration-failure strings.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `node --test test/llm-secrets.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit the secret boundary when Git is available**

```sh
git add src/llm/secrets.ts src/extension.ts src/i18n.ts test/llm-secrets.test.js
git commit -m "feat: secure provider API keys"
```

---

### Task 3: Shared HTTP Transport and Error Taxonomy

**Files:**
- Create: `src/llm/http.ts`
- Create: `test/llm-http.test.js`
- Modify: `src/llm/errors.ts`

**Interfaces:**
- Produces: `postJson<T>(request: JsonRequest): Promise<T>`, `sanitizeRemoteMessage(value)`, and expanded `LLMErrorKind`.
- Consumes: `vscode.CancellationToken`, selected provider/model, `fetch`, and translated messages.

- [ ] **Step 1: Write failing transport tests**

Test a successful JSON POST plus these exact outcomes:

```js
test('posts JSON and returns parsed JSON without logging credentials', async () => {
  global.fetch = async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const result = await postJson({
    provider: 'gemini', model: 'gemini-3.8-flash', url: 'https://example.test',
    headers: { 'x-goog-api-key': 'top-secret' }, body: { input: 'private essay' },
    token, timeoutMs: 300000,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(logs.join('\n').includes('top-secret'), false);
  assert.equal(logs.join('\n').includes('private essay'), false);
});
```

Assert status mapping: `401/403 → auth`, `429 → quota`, `404` with a model message → `model`, other non-2xx → `other`. Assert a remote string containing `Bearer abc`, `sk-...`, or the submitted key is redacted. Assert invalid JSON becomes a response-format error without exposing the body.

- [ ] **Step 2: Add failing cancellation and timeout tests**

Use a pending mocked fetch that rejects with `AbortError` when its signal aborts. Trigger the VS Code cancellation callback and assert `vscode.CancellationError`. Use a short injected timeout and assert `LLMError.kind === 'timeout'` when the token was not cancelled.

- [ ] **Step 3: Run transport tests and verify they fail**

Run: `node --test test/llm-http.test.js`
Expected: FAIL because the shared transport does not exist and error kinds are incomplete.

- [ ] **Step 4: Expand the error model and remove CLI-envelope handling**

Define:

```ts
export type LLMErrorKind =
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'model'
  | 'parse'
  | 'network'
  | 'other';
```

Make `LLMError` carry `kind`, `provider?: LLMProviderId`, `model?: string`, and `status?: number`. Remove `assertNotCliError` and CLI-specific translated fallback text.

- [ ] **Step 5: Implement one safe POST transport**

Define:

```ts
export interface JsonRequest {
  provider: LLMProviderId;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  token: vscode.CancellationToken;
  timeoutMs: number;
  secret?: string;
}

export async function postJson<T>(request: JsonRequest): Promise<T>;
```

The implementation creates one `AbortController`, one timer, and one cancellation subscription; disposes all three paths in `finally`; logs only provider/model/status/duration; reads at most 1000 characters of a failed body; extracts `error.message`, `message`, or plain text; sanitizes the submitted secret plus bearer/key-shaped tokens; and wraps fetch/network failures in `LLMError('network')`. A user-cancelled request must win over timeout/network classification.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `node --test test/llm-http.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the transport when Git is available**

```sh
git add src/llm/http.ts src/llm/errors.ts src/i18n.ts test/llm-http.test.js
git commit -m "feat: add safe LLM HTTP transport"
```

---

### Task 4: Native Gemini and OpenAI Adapters

**Files:**
- Create: `src/llm/providers/gemini.ts`
- Create: `src/llm/providers/openai.ts`
- Create: `test/llm-providers.test.js`

**Interfaces:**
- Consumes: `postJson`, `REVIEW_JSON_SCHEMA`, API key, model, timeout configuration, and cancellation token.
- Produces: `GeminiProvider` and `OpenAIProvider`, both implementing `LLMProvider`.

- [ ] **Step 1: Write failing Gemini contract tests**

Mock `postJson` or `fetch` and assert:

```js
assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
assert.equal(request.headers['x-goog-api-key'], 'gemini-secret');
assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
assert.deepEqual(request.body.generationConfig.responseJsonSchema, REVIEW_JSON_SCHEMA);
assert.equal(request.body.generationConfig.maxOutputTokens, 8192);
```

Return `{ candidates: [{ content: { parts: [{ text: '{"issues":[]}' }] } }] }` and assert `complete()` returns the text. Add cases for blocked/no candidates and missing text, both producing a non-retryable response-format `LLMError`.

- [ ] **Step 2: Write failing OpenAI contract tests**

Assert URL `/v1/responses`, bearer auth, `model`, `input`, `max_output_tokens: 8192`, and strict schema:

```js
assert.deepEqual(request.body.text.format, {
  type: 'json_schema',
  name: 'onewriter_review',
  strict: true,
  schema: REVIEW_JSON_SCHEMA,
});
```

Test extraction from `output[].content[]` entries whose type is `output_text`, concatenating valid text. Missing output text must produce a response-format error.

- [ ] **Step 3: Run adapter tests and verify they fail**

Run: `node --test test/llm-providers.test.js`
Expected: FAIL because both adapter modules do not exist.

- [ ] **Step 4: Implement `GeminiProvider`**

Use constructor `(apiKey: string, model: string)`. URL-encode the model path segment, read `llm.timeoutMs` with fallback `300000`, call `postJson`, and extract only text parts. Keep `name = 'gemini' as const`.

- [ ] **Step 5: Implement `OpenAIProvider`**

Use constructor `(apiKey: string, model: string)`, `Authorization: Bearer`, `content-type: application/json`, the native Responses body from Step 2, and deterministic output-text extraction. Keep `name = 'openai' as const`.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `node --test test/llm-providers.test.js && npm run typecheck`
Expected: PASS for Gemini and OpenAI cases.

- [ ] **Step 7: Commit native adapters when Git is available**

```sh
git add src/llm/providers/gemini.ts src/llm/providers/openai.ts test/llm-providers.test.js
git commit -m "feat: add Gemini and OpenAI REST"
```

---

### Task 5: Qwen and DeepSeek OpenAI-Compatible Adapters

**Files:**
- Create: `src/llm/providers/openai-compatible.ts`
- Create: `src/llm/providers/qwen.ts`
- Create: `src/llm/providers/deepseek.ts`
- Modify: `test/llm-providers.test.js`

**Interfaces:**
- Consumes: `postJson`, provider ID, endpoint, API key, model, prompt, timeout, and cancellation token.
- Produces: `OpenAICompatibleChatProvider`, `QwenProvider`, and `DeepSeekProvider`.

- [ ] **Step 1: Add failing Qwen and DeepSeek contract tests**

For Qwen, assert trailing slashes are removed before appending `/chat/completions`, the default configured base URL is used, bearer auth is set, and the body is:

```js
{
  model: 'qwen3.8-max',
  messages: [{ role: 'user', content: prompt }],
  response_format: { type: 'json_object' },
  max_tokens: 8192,
}
```

For DeepSeek, assert URL `https://api.deepseek.com/chat/completions` and the same chat body with `deepseek-v4-flash`. Return `choices[0].message.content` as both a string and an array of text parts if supported by the response type. Missing content must produce a provider-tagged response-format error.

- [ ] **Step 2: Run the new provider cases and verify they fail**

Run: `node --test --test-name-pattern='Qwen|DeepSeek' test/llm-providers.test.js`
Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement the shared compatible-chat adapter**

Create a constructor accepting:

```ts
interface CompatibleChatOptions {
  provider: 'qwen' | 'deepseek';
  apiKey: string;
  model: string;
  endpoint: string;
}
```

The class owns request serialization and response extraction only. It uses `postJson`, emits no secret-bearing logs, and throws an `LLMError` tagged with the concrete provider/model when the content shape is invalid.

- [ ] **Step 4: Implement thin provider wrappers**

`QwenProvider` reads `llm.qwen.baseUrl`, normalizes one trailing slash, and passes `<base>/chat/completions`. `DeepSeekProvider` uses the fixed native base. Both expose the concrete provider name through the shared adapter.

- [ ] **Step 5: Run all adapter tests and typecheck**

Run: `node --test test/llm-providers.test.js && npm run typecheck`
Expected: PASS for Gemini, OpenAI, Qwen, and DeepSeek.

- [ ] **Step 6: Commit compatible adapters when Git is available**

```sh
git add src/llm/providers/openai-compatible.ts src/llm/providers/qwen.ts src/llm/providers/deepseek.ts test/llm-providers.test.js
git commit -m "feat: add Qwen and DeepSeek REST"
```

---

### Task 6: Native Claude Adapter

**Files:**
- Create: `src/llm/providers/claude.ts`
- Modify: `test/llm-providers.test.js`

**Interfaces:**
- Consumes: `postJson`, API key, model, prompt, timeout, and cancellation token.
- Produces: `ClaudeProvider` implementing `LLMProvider` without assistant prefill.

- [ ] **Step 1: Add failing Claude request and extraction tests**

Assert the exact endpoint and headers:

```js
assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
assert.equal(request.headers['x-api-key'], 'claude-secret');
assert.equal(request.headers['anthropic-version'], '2023-06-01');
assert.equal(request.body.model, 'claude-sonnet-4-6');
assert.equal(request.body.max_tokens, 8192);
assert.deepEqual(request.body.messages, [{ role: 'user', content: prompt }]);
assert.equal(request.body.messages.some((message) => message.role === 'assistant'), false);
assert.deepEqual(request.body.output_config, {
  format: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA },
});
```

Return multiple `{ type: 'text', text }` blocks and assert they concatenate. Ignore non-text blocks. Reject a response with no text blocks as a provider response-format error.

- [ ] **Step 2: Run the Claude cases and verify they fail**

Run: `node --test --test-name-pattern='Claude' test/llm-providers.test.js`
Expected: FAIL because `ClaudeProvider` does not exist.

- [ ] **Step 3: Implement `ClaudeProvider`**

Use constructor `(apiKey: string, model: string)`, native Messages headers/body, `max_tokens: 8192`, `output_config.format: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA }`, and no assistant prefill. Keep JSON constraints in the common prompt as defense in depth, and cover the exact request shape in the test from Step 1.

- [ ] **Step 4: Run every provider test and typecheck**

Run: `node --test test/llm-providers.test.js && npm run typecheck`
Expected: PASS for all five providers.

- [ ] **Step 5: Commit Claude adapter when Git is available**

```sh
git add src/llm/providers/claude.ts test/llm-providers.test.js
git commit -m "feat: add Claude REST provider"
```

---

### Task 7: Factory, Review Error UX, Sidebar, and CLI Removal

**Files:**
- Create: `test/llm-factory.test.js`
- Modify: `src/llm/provider.ts`
- Modify: `src/review/controller.ts`
- Modify: `src/ui/sidebar.ts`
- Modify: `src/i18n.ts`
- Delete: `src/llm/cli.ts`
- Delete: `src/llm/api.ts`

**Interfaces:**
- Consumes: five adapters, `getApiKey`, `promptForApiKey`, provider metadata, existing prompt/parser/normalizer, and review controller.
- Produces: provider-aware `createProvider(context)`, unchanged `requestReview(...)`, actionable REST-only error UX, and provider/model sidebar state.

- [ ] **Step 1: Write failing factory selection tests**

Use a VS Code configuration/SecretStorage mock and assert that each provider value constructs an object whose `name` matches and whose model comes from its own setting. Assert an absent/invalid provider falls back to Gemini. Assert a missing key offers only Set API Key and Cancel, passes the selected provider into the set-key flow, and never changes provider automatically.

```js
for (const provider of ['gemini', 'openai', 'qwen', 'deepseek', 'claude']) {
  test(`factory creates ${provider}`, async () => {
    settings.set('llm.provider', provider);
    secrets.set(`onewriter.apiKey.${provider}`, `${provider}-secret`);
    assert.equal((await createProvider(context)).name, provider);
  });
}
```

- [ ] **Step 2: Preserve review parsing behavior with focused tests**

Add a provider stub and assert valid raw JSON normalizes on the first call, malformed JSON retries exactly once with the strict suffix, `LLMError` auth/quota/model/timeout failures are not retried, and a second malformed result becomes `kind: 'parse'`.

- [ ] **Step 3: Run factory tests and verify they fail**

Run: `node --test test/llm-factory.test.js`
Expected: FAIL because the factory still branches on `cli | api`.

- [ ] **Step 4: Replace the factory with the provider registry**

Read the selected provider with fallback `gemini`, normalize invalid values with `isProviderId`, resolve its key/model from metadata, and instantiate the matching adapter with an exhaustive switch. If no key exists, show the provider-aware missing-key message and offer Set API Key; after successful entry, resolve once more. Return `undefined` on cancellation. Do not update settings as a side effect.

- [ ] **Step 5: Replace CLI error UX with provider-aware REST actions**

In `ReviewController.reportError`:

- Remove `usingCli`, binary extraction, terminal creation, login commands, and provider switching.
- For `auth`, show provider/model and offer `onewriter.setApiKey` for the current provider.
- For `model`, offer to open `@ext:onewriter.onewriter` Settings.
- For `quota`, show the localized quota message.
- For `timeout`, state the configured duration and setting name.
- For all other failures, offer the sanitized Output log.

- [ ] **Step 6: Update sidebar provider status and runtime localization**

Resolve provider metadata and model dynamically, then send `provider: `${definition.label} · ${model}``. Remove all runtime keys mentioning CLI, terminal login, or Anthropic-only setup. Add provider-aware strings in English, Vietnamese, and Japanese, keeping English as the complete source-key union.

- [ ] **Step 7: Delete the old provider files and assert no CLI production references remain**

Delete `src/llm/cli.ts` and `src/llm/api.ts`. Add this manifest/source regression assertion:

```js
test('production source contains no LLM CLI execution path', () => {
  const source = fs.readdirSync(path.join(root, 'src/llm'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(root, 'src/llm', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /child_process|\bspawn\s*\(|CliProvider|llm\.cliCommand|llm\.cliCwd/);
});
```

Make the scan recursive so files under `src/llm/providers` are included.

- [ ] **Step 8: Run factory, manifest, config, and type tests**

Run: `node --test test/llm-factory.test.js test/manifest.test.js test/config.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit integration and CLI removal when Git is available**

```sh
git add src/llm/provider.ts src/llm/errors.ts src/review/controller.ts src/ui/sidebar.ts src/i18n.ts src/llm/cli.ts src/llm/api.ts test/llm-factory.test.js test/manifest.test.js
git commit -m "feat: switch reviews to REST providers"
```

---

### Task 8: Documentation, Security Regression, and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `test/llm-http.test.js`
- Modify: `test/manifest.test.js`
- Regenerate: `dist/extension.js`

**Interfaces:**
- Consumes: the completed five-provider feature and existing npm scripts.
- Produces: user setup documentation and final release evidence.

- [ ] **Step 1: Add final documentation assertions**

In `test/manifest.test.js`, read `README.md` and assert it names all five providers, `SecretStorage`, the five environment variables, the Qwen regional base URL, `onewriter.setApiKey`, and `onewriter.deleteApiKey`. Assert it contains no setup instructions for `codex exec`, `claude` CLI login, `onewriter.llm.cliCommand`, or `onewriter.llm.cliCwd`.

- [ ] **Step 2: Run documentation assertions and verify they fail**

Run: `node --test test/manifest.test.js`
Expected: FAIL because README still documents CLI/API mode.

- [ ] **Step 3: Rewrite the README provider setup**

Document:

- Gemini as the default with `gemini-3.8-flash`.
- How to run `OneWriter: Set API Key`, select a provider, and understand SecretStorage.
- How to run `OneWriter: Delete API Key`.
- Each model setting and environment fallback.
- Qwen's Singapore default and how to supply a Japan/dedicated endpoint.
- The five-minute timeout and Cancel behavior.
- Migration behavior for legacy CLI and Anthropic API users.
- Front matter precedence with the existing Japanese N2 example.

Remove every CLI installation, command, login, trusted-directory, and `--skip-git-repo-check` instruction.

- [ ] **Step 4: Run the complete test suite**

Run: `npm test`
Expected: all Node tests PASS with no network calls.

- [ ] **Step 5: Run static verification**

Run: `npm run typecheck`
Expected: PASS with no TypeScript errors or unused declarations.

- [ ] **Step 6: Build the production extension**

Run: `npm run build`
Expected: PASS and regenerate `dist/extension.js`.

- [ ] **Step 7: Inspect the bundle for forbidden CLI and secret content**

Run:

```sh
rg -n "child_process|codex exec|CliProvider|onewriter\.llm\.cli(Command|Cwd)|onewriter\.anthropicApiKey" src dist package.json README.md
```

Expected: the only allowed `onewriter.anthropicApiKey` reference is the migration read in `src/llm/secrets.ts` and its bundled equivalent; no CLI execution/configuration references remain. Test/spec/plan files are intentionally excluded from this release scan.

- [ ] **Step 8: Perform the verification-before-completion gate**

Re-run, without relying on earlier output:

```sh
npm test
npm run typecheck
npm run build
```

Record test counts and exit statuses in the final handoff. Do not claim live-provider success unless a user-supplied key was used for an explicitly authorized smoke test; mocked protocol tests are the required automated proof.

- [ ] **Step 9: Request an independent code review**

Review the final diff against `docs/superpowers/specs/2026-09-11-rest-llm-providers-design.md`, prioritizing credential leakage, migration data loss, provider request-shape mismatches, cancellation races, and lingering CLI paths. Resolve every confirmed issue and rerun Step 8.

- [ ] **Step 10: Commit the release-ready change when Git is available**

```sh
git add README.md dist/extension.js test/llm-http.test.js test/manifest.test.js
git commit -m "docs: document REST provider setup"
```
