import * as vscode from 'vscode';
import type { LLMOutputFormat, LLMProvider } from '../../types';
import { t } from '../../i18n';
import { LLMError } from '../errors';
import { postJson, sanitizeRemoteMessage } from '../http';
import { REVIEW_OUTPUT_FORMAT } from '../schema';

interface ClaudeResponse {
  content?: unknown;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(
    prompt: string,
    token: vscode.CancellationToken,
    format?: LLMOutputFormat,
  ): Promise<string> {
    const output = format ?? REVIEW_OUTPUT_FORMAT;
    const timeoutMs = vscode.workspace
      .getConfiguration('onewriter')
      .get<number>('llm.timeoutMs', 300000);
    const data = await postJson<ClaudeResponse>({
      provider: this.name,
      model: this.model,
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: this.model,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: { type: 'json_schema', schema: output.schema },
        },
      },
      token,
      timeoutMs,
      secret: this.apiKey,
    });
    const text = this.extractText(data?.content);

    if (!text) throw this.responseFormatError();
    return text;
  }

  private extractText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content.flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const textBlock = block as { type?: unknown; text?: unknown };
      return textBlock.type === 'text' && typeof textBlock.text === 'string' ? [textBlock.text] : [];
    }).join('');
  }

  private responseFormatError(): LLMError {
    return new LLMError(t('llm.responseFormat'), false, 'parse', {
      provider: this.name,
      model: sanitizeRemoteMessage(this.model, this.apiKey),
    });
  }
}
