import * as vscode from 'vscode';
import type { LLMOutputFormat, LLMProvider } from '../../types';
import { t } from '../../i18n';
import { LLMError } from '../errors';
import { postJson, sanitizeRemoteMessage } from '../http';
import { REVIEW_OUTPUT_FORMAT } from '../schema';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: unknown }>;
    };
  }>;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini' as const;

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
    const data = await postJson<GeminiResponse>({
      provider: this.name,
      model: this.model,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: output.schema,
          maxOutputTokens: 8192,
        },
      },
      token,
      timeoutMs,
      secret: this.apiKey,
    });
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const text = parts
        .flatMap((part) => typeof part?.text === 'string' ? [part.text] : [])
        .join('');
      if (text.trim()) return text;
    }
    throw this.responseFormatError();
  }

  private responseFormatError(): LLMError {
    return new LLMError(t('llm.responseFormat'), false, 'parse', {
      provider: this.name,
      model: sanitizeRemoteMessage(this.model, this.apiKey),
    });
  }
}
