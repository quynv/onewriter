import * as vscode from 'vscode';
import type { LLMOutputFormat } from '../../types';
import { t } from '../../i18n';
import { LLMError } from '../errors';
import { sanitizeRemoteMessage } from '../http';
import { OpenAICompatibleChatProvider } from './openai-compatible';

export const DEFAULT_QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export class QwenProvider extends OpenAICompatibleChatProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: unknown = DEFAULT_QWEN_BASE_URL,
  ) {
    super({ provider: 'qwen', apiKey, model,
      endpoint: `${typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : ''}/chat/completions` });
  }

  async complete(
    prompt: string,
    token: vscode.CancellationToken,
    format?: LLMOutputFormat,
  ): Promise<string> {
    let valid = false;
    try {
      valid = typeof this.baseUrl === 'string' && new URL(this.baseUrl).protocol === 'https:';
    } catch { /* Configuration errors must not retain the URL or parser error. */ }
    if (!valid) {
      throw new LLMError(t('llm.qwenInvalidBaseUrl'), false, 'configuration', {
        provider: this.name,
        model: sanitizeRemoteMessage(this.model, this.apiKey),
      });
    }
    return super.complete(prompt, token, format);
  }
}
