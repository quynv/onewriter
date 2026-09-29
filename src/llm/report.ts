import * as vscode from 'vscode';
import { LLMError } from './errors';
import { sanitizeRemoteMessage } from './http';
import { getApiKey } from './secrets';
import { getProviderModel, isProviderId, PROVIDERS } from './providers/types';
import { showOutput } from '../output';
import { t } from '../i18n';

/** Offer recovery for the failed provider using only local, safe message templates. */
export async function reportLlmError(
  context: vscode.ExtensionContext,
  err: unknown,
  resource?: vscode.Uri,
  operation: 'review' | 'chunks' | 'source' = 'review',
): Promise<void> {
  const kind = err instanceof LLMError ? err.kind : 'other';
  const exhaustedReviewParsing = err instanceof LLMError && err.message === t('llm.badJson');
  const cfg = vscode.workspace.getConfiguration('onewriter', resource);
  const selected = err instanceof LLMError && err.provider
    ? err.provider : cfg.get<unknown>('llm.provider', 'gemini');
  const provider = isProviderId(selected) ? selected : 'gemini';
  const rawModel = err instanceof LLMError && err.model ? err.model : getProviderModel(cfg, provider);
  const secret = await getApiKey(context, provider);
  const details = {
    provider: PROVIDERS[provider].label,
    model: sanitizeRemoteMessage(rawModel, secret),
  };

  if (kind === 'auth') {
    const setKey = t('action.setApiKey');
    const action = await vscode.window.showErrorMessage(t('auth.failed', details), setKey);
    if (action === setKey) {
      await vscode.commands.executeCommand('onewriter.setApiKey', provider);
    }
    return;
  }

  if (kind === 'model' || kind === 'configuration') {
    const settings = t('action.openSettings');
    const message = kind === 'model' ? t('llm.modelUnavailable', details)
      : t('llm.reviewFailed', { ...details, reason: t('llm.qwenInvalidBaseUrl') });
    const action = await vscode.window.showErrorMessage(message, settings);
    if (action === settings) {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:onewriter.onewriter');
    }
    return;
  }

  if (kind === 'quota') {
    await vscode.window.showErrorMessage(t('quota.hit', details), { modal: false });
    return;
  }

  if (kind === 'timeout') {
    const timeoutKey = operation === 'chunks' ? 'llm.chunksTimeout'
      : operation === 'source' ? 'llm.sourceTimeout' : 'llm.reviewTimeout';
    await vscode.window.showErrorMessage(t(timeoutKey, {
      ...details,
      seconds: Math.round(cfg.get<number>('llm.timeoutMs', 300000) / 1000),
    }));
    return;
  }

  const openLog = t('action.openLog');
  const reason = kind === 'parse'
    ? t(operation === 'chunks' ? 'llm.chunksParse' : exhaustedReviewParsing ? 'llm.badJson' : 'llm.responseFormat')
    : kind === 'network' ? t('llm.networkError') : t('llm.requestFailed');
  const message = t('llm.reviewFailed', { ...details, reason });
  const action = await vscode.window.showErrorMessage(message, openLog);
  if (action === openLog) {
    showOutput();
  }
}
