import * as vscode from 'vscode';
import type { LLMOutputFormat, LLMProvider } from '../../types';
import { t } from '../../i18n';
import { LLMError } from '../errors';
import { postJson, sanitizeRemoteMessage } from '../http';
import { REVIEW_OUTPUT_FORMAT } from '../schema';

interface OpenAIResponse {
  output?: Array<{
    content?: Array<{ type?: unknown; text?: unknown }>;
  }>;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;

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
    const data = await postJson<OpenAIResponse>({
      provider: this.name,
      model: this.model,
      url: 'https://api.openai.com/v1/responses',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: {
        model: this.model,
        input: prompt,
        max_output_tokens: 8192,
        text: {
          format: {
            type: 'json_schema',
            name: output.name,
            strict: true,
            schema: output.schema,
          },
        },
      },
      token,
      timeoutMs,
      secret: this.apiKey,
    });
    const content = Array.isArray(data?.output)
      ? data.output.flatMap((output) => Array.isArray(output?.content) ? output.content : [])
      : [];
    const text = content
      .flatMap((content) => content?.type === 'output_text' && typeof content.text === 'string'
        ? [content.text] : [])
      .join('');

    if (!text) throw this.responseFormatError();
    return text;
  }

  private responseFormatError(): LLMError {
    return new LLMError(t('llm.responseFormat'), false, 'parse', {
      provider: this.name,
      model: sanitizeRemoteMessage(this.model, this.apiKey),
    });
  }
}
