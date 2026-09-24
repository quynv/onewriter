import * as vscode from 'vscode';
import type { LLMOutputFormat, LLMProvider } from '../../types';
import { t } from '../../i18n';
import { LLMError } from '../errors';
import { postJson, sanitizeRemoteMessage } from '../http';

export interface CompatibleChatOptions {
  provider: 'qwen' | 'deepseek';
  apiKey: string;
  model: string;
  endpoint: string;
}

interface CompatibleChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export class OpenAICompatibleChatProvider implements LLMProvider {
  readonly name: CompatibleChatOptions['provider'];

  constructor(private readonly options: CompatibleChatOptions) {
    this.name = options.provider;
  }

  async complete(
    prompt: string,
    token: vscode.CancellationToken,
    _format?: LLMOutputFormat,
  ): Promise<string> {
    const timeoutMs = vscode.workspace
      .getConfiguration('onewriter')
      .get<number>('llm.timeoutMs', 300000);
    const data = await postJson<CompatibleChatResponse>({
      provider: this.name,
      model: this.options.model,
      url: this.options.endpoint,
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: {
        model: this.options.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 8192,
      },
      token,
      timeoutMs,
      secret: this.options.apiKey,
    });
    const text = this.extractText(data?.choices?.[0]?.message?.content);

    if (!text) throw this.responseFormatError();
    return text;
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const textPart = part as { type?: unknown; text?: unknown };
      return textPart.type === 'text' && typeof textPart.text === 'string' ? [textPart.text] : [];
    }).join('');
  }

  private responseFormatError(): LLMError {
    return new LLMError(t('llm.responseFormat'), false, 'parse', {
      provider: this.name,
      model: sanitizeRemoteMessage(this.options.model, this.options.apiKey),
    });
  }
}
