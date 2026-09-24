import * as vscode from 'vscode';
import { t } from '../i18n';
import { log } from '../output';
import { LLMError, type LLMErrorKind } from './errors';
import type { LLMProviderId } from './providers/types';

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

/** Remote text is never trusted as a log message or retained as an error cause. */
export function sanitizeRemoteMessage(value: unknown, secret?: string): string {
  if (typeof value !== 'string') return '';
  let message = value;
  if (secret) {
    message = message.split(secret).join('[REDACTED]');
    // An error body may end in the middle of a credential at the read limit.
    for (let length = Math.min(secret.length - 1, message.length); length >= 3; length--) {
      if (message.endsWith(secret.slice(0, length))) {
        message = message.slice(0, -length) + '[REDACTED]';
        break;
      }
    }
  }
  return message
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]*/g, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

async function readErrorMessage(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < 1000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value.subarray(0, (1000 - text.length) * 4), { stream: true })
        .slice(0, 1000 - text.length);
    }
  } finally {
    // Stop reading the body as soon as enough diagnostic text is available.
    try { await reader.cancel(); } catch { /* Preserve the original read failure. */ }
    reader.releaseLock();
  }
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === 'object') {
      const object = data as { error?: { message?: unknown }; message?: unknown };
      if (typeof object.error?.message === 'string') return object.error.message;
      if (typeof object.message === 'string') return object.message;
      return '';
    }
    return typeof data === 'string' ? data : '';
  } catch {
    return text;
  }
}

function statusKind(status: number, message: string): LLMErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  const invalidModel = /(?:invalid|unknown|unsupported|unrecognized)\s+model|model[^\n]*(?:not found|does not exist|not supported|not available)|\bmodel\s+not\s+exist\b/i;
  if (status === 404 || (status === 400 && invalidModel.test(message))) return 'model';
  return 'other';
}

export async function postJson<T>(request: JsonRequest): Promise<T> {
  const { provider, model, token, timeoutMs, secret } = request;
  if (token.isCancellationRequested) throw new vscode.CancellationError();
  const credentials = [secret, ...Object.entries(request.headers)
    .filter(([name]) => /^(?:authorization|x-api-key|x-goog-api-key|api-key)$/i.test(name))
    .map(([, value]) => value.replace(/^Bearer\s+/i, ''))]
    .filter((value): value is string => Boolean(value));
  const sanitize = (value: string): string => sanitizeRemoteMessage(
    credentials.reduce((message, credential) => sanitizeRemoteMessage(message, credential), value),
  );

  const controller = new AbortController();
  const started = Date.now();
  let timedOut = false;
  let status: number | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const subscription = token.onCancellationRequested(() => controller.abort());
  const checkAborted = (): void => {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (timedOut) {
      throw new LLMError(t('llm.apiTimeout', { seconds: Math.round(timeoutMs / 1000) }),
        false, 'timeout', { provider, model: sanitize(model), status });
    }
  };

  try {
    checkAborted();
    const headers = new Headers(request.headers);
    headers.set('Content-Type', 'application/json');
    const response = await fetch(request.url, {
      method: 'POST', headers, body: JSON.stringify(request.body), signal: controller.signal,
    });
    status = response.status;
    checkAborted();
    if (!response.ok) {
      // Inspect bounded remote text only for classification; never surface or retain it.
      const kind = statusKind(status, await readErrorMessage(response));
      checkAborted();
      const messageKey = kind === 'auth' ? 'llm.httpAuth'
        : kind === 'quota' ? 'llm.httpQuota'
          : kind === 'model' ? 'llm.httpModel' : 'llm.httpError';
      throw new LLMError(t(messageKey, { status, provider, model: sanitize(model) }), false,
        kind, { provider, model: sanitize(model), status });
    }
    try {
      const data = await response.json() as T;
      checkAborted();
      return data;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new LLMError(t('llm.responseFormat'), false, 'parse', {
          provider, model: sanitize(model), status,
        });
      }
      throw error;
    }
  } catch (error) {
    checkAborted();
    if (error instanceof LLMError) throw error;
    throw new LLMError(t('llm.networkError'), false, 'network', {
      provider, model: sanitize(model), status,
    });
  } finally {
    clearTimeout(timer);
    subscription.dispose();
    log(`provider=${provider} model=${sanitize(model)} status=${status ?? 'none'} durationMs=${Date.now() - started}`);
  }
}
