import * as vscode from 'vscode';
import { LLMProvider, ResolvedConfig, ReviewResult } from '../types';
import { getApiKey, promptForApiKey } from './secrets';
import { getProviderModel, isProviderId, PROVIDERS } from './providers/types';
import { GeminiProvider } from './providers/gemini';
import { OpenAIProvider } from './providers/openai';
import { DEFAULT_QWEN_BASE_URL, QwenProvider } from './providers/qwen';
import { DeepSeekProvider } from './providers/deepseek';
import { ClaudeProvider } from './providers/claude';
import { buildPrompt } from './prompt';
import { extractJsonObject } from './json';
import { normaliseResult } from './validate';
import { LLMError } from './errors';
import { REVIEW_OUTPUT_FORMAT } from './schema';
import { log } from '../output';
import { t } from '../i18n';

export async function createProvider(
  context: vscode.ExtensionContext,
  resource?: vscode.Uri,
): Promise<LLMProvider | undefined> {
  const cfg = vscode.workspace.getConfiguration('onewriter', resource);
  const selected = cfg.get<unknown>('llm.provider', 'gemini');
  const provider = isProviderId(selected) ? selected : 'gemini';
  let key = await getApiKey(context, provider);
  if (!key) {
    const setKey = t('action.setApiKey');
    const answer = await vscode.window.showWarningMessage(
      t('auth.noKey', { provider: PROVIDERS[provider].label }),
      setKey,
      t('action.cancel'),
    );
    if (answer !== setKey || !(await promptForApiKey(context, provider))) return undefined;
    key = await getApiKey(context, provider);
    if (!key) return undefined;
  }
  const model = getProviderModel(cfg, provider);
  switch (provider) {
    case 'gemini': return new GeminiProvider(key, model);
    case 'openai': return new OpenAIProvider(key, model);
    case 'qwen': return new QwenProvider(key, model,
      cfg.get<unknown>('llm.qwen.baseUrl', DEFAULT_QWEN_BASE_URL));
    case 'deepseek': return new DeepSeekProvider(key, model);
    case 'claude': return new ClaudeProvider(key, model);
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

/**
 * Call the model and retry once with a stricter prompt when review JSON cannot be parsed.
 */
export async function requestReview(
  llm: LLMProvider,
  text: string,
  config: ResolvedConfig,
  token: vscode.CancellationToken,
  source?: string,
): Promise<ReviewResult> {
  const prompt = buildPrompt(text, config, source);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const input =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYour previous reply could not be parsed. Reply with the raw JSON object only. Start your reply with { and end it with }. No explanation, no code fence.`;

    let raw: string;
    try {
      raw = await llm.complete(input, token, REVIEW_OUTPUT_FORMAT);
    } catch (err) {
      if (err instanceof vscode.CancellationError || err instanceof LLMError) {
        throw err;
      }
      throw new LLMError(t('llm.requestFailed'), false, 'other', { provider: llm.name });
    }

    try {
      return normaliseResult(extractJsonObject(raw));
    } catch (err) {
      // Lỗi xác thực hay hết quota thì retry vô ích, ném thẳng lên.
      if (err instanceof LLMError && !err.retryable) {
        throw err;
      }
      log(`Review JSON parse failed: provider=${llm.name} attempt=${attempt}`);
      if (attempt === 2) {
        throw new LLMError(t('llm.badJson'), false, 'parse', { provider: llm.name });
      }
    }
  }

  throw new LLMError(t('llm.noResult'), false);
}
