# OneWriter REST LLM Providers Design

**Date:** 2026-09-11
**Status:** Approved in chat; awaiting written-spec review

## Goal

Replace every CLI-based review path with direct REST API integrations for Gemini, OpenAI, Qwen, DeepSeek, and Claude. Gemini is the default provider. API keys entered through OneWriter must be stored in VS Code SecretStorage and must never be written to ordinary settings or logs.

## Scope

This change covers provider selection, provider-specific REST clients, model settings, secret management, configuration migration, error reporting, localization, sidebar status, documentation, and automated tests.

It does not add streaming, OAuth, proxy management, provider account setup, automatic model discovery, or a generic custom OpenAI-compatible provider.

## Provider Configuration

`onewriter.llm.provider` accepts these values:

- `gemini` (default)
- `openai`
- `qwen`
- `deepseek`
- `claude`

Each provider keeps its own editable model setting so switching providers does not discard the previous model choice:

| Provider | Setting | Default model |
| --- | --- | --- |
| Gemini | `onewriter.llm.gemini.model` | `gemini-3.8-flash` |
| OpenAI | `onewriter.llm.openai.model` | `gpt-5.6-luna` |
| Qwen | `onewriter.llm.qwen.model` | `qwen3.8-max` |
| DeepSeek | `onewriter.llm.deepseek.model` | `deepseek-v4-flash` |
| Claude | `onewriter.llm.claude.model` | `claude-sonnet-4-6` |

Qwen additionally exposes `onewriter.llm.qwen.baseUrl`, defaulting to the international Singapore OpenAI-compatible endpoint `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. This lets users supply a Japan or dedicated-workspace endpoint without changing code. No other custom endpoint is introduced.

The existing `onewriter.llm.timeoutMs` remains shared by all providers and defaults to `300000`. Provider requests permit at least 8192 output tokens where the remote API exposes an output-token limit.

The following settings are removed from the contributed configuration:

- `onewriter.llm.cliCommand`
- `onewriter.llm.cliCwd`
- `onewriter.llm.apiModel`

## Architecture

The public `LLMProvider` contract remains small:

```ts
interface LLMProvider {
  readonly name: LLMProviderId;
  complete(prompt: string, token: vscode.CancellationToken): Promise<string>;
}
```

`LLMProviderId` is the five-value provider union. `createProvider` reads the selected provider, resolves its secret and model configuration, and constructs the matching REST adapter. There is no CLI fallback.

The provider layer is split by responsibility:

- `src/llm/providers/types.ts` owns provider IDs, metadata, model setting names, environment-variable names, and endpoint defaults.
- `src/llm/secrets.ts` owns SecretStorage reads, environment fallback, provider selection for set/delete commands, and legacy-secret migration.
- `src/llm/http.ts` owns timeout/cancellation wiring, safe HTTP error extraction, and common `fetch` behavior.
- `src/llm/providers/gemini.ts`, `openai.ts`, `qwen.ts`, `deepseek.ts`, and `claude.ts` own request serialization and response extraction for one vendor each.
- `src/llm/provider.ts` remains the factory and review orchestration entry point.
- `src/llm/schema.ts` owns the JSON schema sent to APIs that support structured output.

All clients use the runtime `fetch`; no vendor SDK is added.

## REST Protocols

### Gemini

Gemini calls native `generateContent` at `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, authenticates with `x-goog-api-key`, and requests `application/json` structured output with the shared review schema. It extracts the text from the first valid candidate.

### OpenAI

OpenAI calls the native Responses API at `https://api.openai.com/v1/responses`, authenticates with `Authorization: Bearer`, and supplies the shared schema as a strict JSON-schema text format. It extracts the response's output text.

### Qwen

Qwen calls `{baseUrl}/chat/completions`, authenticates with `Authorization: Bearer`, and uses the OpenAI-compatible chat request shape. It requests JSON output and extracts `choices[0].message.content`.

### DeepSeek

DeepSeek calls `https://api.deepseek.com/chat/completions`, authenticates with `Authorization: Bearer`, and uses the OpenAI-compatible chat request shape. It requests JSON output and extracts `choices[0].message.content`.

### Claude

Claude calls `https://api.anthropic.com/v1/messages`, authenticates with `x-api-key` and `anthropic-version`, sends the shared schema through `output_config.format` with type `json_schema`, and extracts all text content blocks. The adapter does not use assistant prefill because prefill is incompatible with Claude JSON structured output.

## Review Data Flow

1. The controller strips front matter and resolves the document config.
2. Front matter `lang` and `level`, when valid, continue to override workspace settings. Missing or invalid values fall back to settings.
3. The factory reads `onewriter.llm.provider`, then resolves the provider key from SecretStorage or its environment variable.
4. If no key exists, OneWriter offers to open the provider-aware Set API Key flow. It never changes providers automatically.
5. The selected adapter sends the prompt over HTTPS with cancellation and the configured timeout.
6. Structured output is extracted as text, parsed with `extractJsonObject`, and normalized with `normaliseResult`.
7. A malformed model response may be retried once with the existing stricter JSON-only prompt. Authentication, quota, invalid-model, and timeout failures are never retried by this layer.
8. The controller locates issue ranges and renders the review exactly as it does today.

## Secret Management

Keys entered through `OneWriter: Set API Key` are stored only in `ExtensionContext.secrets`, under these IDs:

| Provider | Secret ID | Environment fallback |
| --- | --- | --- |
| Gemini | `onewriter.apiKey.gemini` | `GEMINI_API_KEY` |
| OpenAI | `onewriter.apiKey.openai` | `OPENAI_API_KEY` |
| Qwen | `onewriter.apiKey.qwen` | `DASHSCOPE_API_KEY` |
| DeepSeek | `onewriter.apiKey.deepseek` | `DEEPSEEK_API_KEY` |
| Claude | `onewriter.apiKey.claude` | `ANTHROPIC_API_KEY` |

SecretStorage takes precedence over the environment. The Set API Key command first shows a provider QuickPick, then a password input. Validation only requires a non-empty trimmed value because provider key formats vary and can change. The command confirms the provider name, never the secret value.

`OneWriter: Delete API Key` selects a provider and deletes only that provider's SecretStorage value. It does not alter environment variables and clearly reports when an environment fallback will still be used.

Keys, authorization headers, and complete remote error bodies must never be logged. Logs may include provider, model, HTTP status, request duration, and a sanitized/truncated error message.

## Error Handling

`LLMError.kind` expands to distinguish `auth`, `quota`, `timeout`, `model`, `parse`, `network`, and `other`.

- `401`/`403`: identify the provider and offer Set API Key.
- `429`: report rate limit/quota without retrying the entire review.
- Provider-specific invalid-model responses or `404`: identify the configured model and direct the user to Settings.
- Timeout/abort: distinguish user cancellation from the configured request timeout.
- Non-2xx response: parse a short provider error message, sanitize likely secrets, then discard the full body.
- Missing or malformed response fields: report a provider response-format error.
- Invalid review JSON: retry once, then return the existing localized bad-JSON error.

The sidebar displays `<Provider> · <model>`. All CLI login, terminal-opening, and CLI error-envelope logic is removed.

## Migration and Rollback Safety

Migration runs once during activation and is safe to retry after partial failure:

1. If `onewriter.apiKey.claude` is absent and legacy `onewriter.anthropicApiKey` exists, copy the legacy value into the new Claude secret.
2. Verify the copied value can be read before recording migration completion.
3. Preserve the legacy secret as rollback data; deleting it is outside this change and requires a separate explicit cleanup decision.
4. If the explicitly configured old provider is `api`, update it to `claude`.
5. If the explicitly configured old provider is `cli`, update it to `gemini`.
6. If an explicit legacy `onewriter.llm.apiModel` value exists and no explicit Claude model exists, copy it to `onewriter.llm.claude.model`.
7. Record a versioned migration marker in `globalState` only after all applicable writes succeed.

A fresh installation gets Gemini with `gemini-3.8-flash`. A migrated CLI user is prompted for a Gemini key at the first review if neither SecretStorage nor `GEMINI_API_KEY` supplies one. A migrated API user continues with Claude and the copied key/model.

Rollback to the old extension remains possible because old configuration values and the legacy Anthropic secret are not destructively deleted.

## Localization and Documentation

All new commands, provider names, settings descriptions, key prompts, migration notices, and error actions are added to English, Vietnamese, and Japanese bundles. Obsolete CLI strings and README instructions are removed. The README documents all five providers, environment fallbacks, Qwen regional configuration, secure key storage, and how to delete a stored key.

## Testing

Tests use mocked `fetch`, cancellation tokens, SecretStorage, workspace configuration, and global state. No live API keys or network requests are used.

Coverage must include:

- Manifest default is Gemini and no contributed CLI settings remain.
- All five provider/model defaults and Qwen base URL are correct.
- Every localization placeholder resolves in all locale bundles.
- Set/get/delete key behavior, SecretStorage precedence, and environment fallback.
- Idempotent migration from old `api` and `cli` configurations, including partial migration recovery and preservation of the legacy secret.
- Correct URL, authentication header, model, JSON-output control, and response extraction for every adapter.
- No key appears in logs or surfaced HTTP errors.
- User cancellation, timeout, auth, quota, invalid model, network failure, malformed provider response, retryable review JSON, and final parse failure.
- Existing front matter precedence tests remain green.

Final verification is:

```sh
npm test
npm run typecheck
npm run build
```

## Acceptance Criteria

- No production code can execute an LLM CLI or spawn an LLM process.
- A new installation selects Gemini and `gemini-3.8-flash`.
- Reviews can be requested through each of the five REST providers using its configured model.
- Keys entered in OneWriter exist only in VS Code SecretStorage.
- Environment fallback works without copying environment secrets into storage.
- Old Anthropic API users migrate without re-entering their key.
- Old CLI users migrate to Gemini and receive an actionable missing-key prompt.
- Provider errors are actionable and contain no credentials.
- Document front matter retains precedence over settings.
- Tests, type checking, and the production build pass.

## Reference APIs

- [Gemini API keys](https://ai.google.dev/gemini-api/docs/generate-content/api-key)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Qwen model and endpoint documentation](https://help.aliyun.com/en/model-studio/list-models)
- [DeepSeek API documentation](https://api-docs.deepseek.com/)
- [Claude Messages API](https://docs.anthropic.com/en/api/messages)
