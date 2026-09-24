import * as vscode from 'vscode';
import { t } from '../i18n';
import { LLMProviderId, PROVIDERS } from './providers/types';

export const MIGRATION_KEY = 'onewriter.llmMigrationVersion';
export const MIGRATION_VERSION = 1;
const LEGACY_ANTHROPIC_SECRET = 'onewriter.anthropicApiKey';

interface ExplicitSetting<T> {
  value: T;
  target: vscode.ConfigurationTarget;
}

interface InspectedSetting<T> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

export function validateKey(value: string): string | undefined {
  return value.trim() ? undefined : t('auth.keyRequired');
}

export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: LLMProviderId,
): Promise<string | undefined> {
  const definition = PROVIDERS[provider];
  const stored = await context.secrets.get(definition.secretId);
  return stored || process.env[definition.environmentVariable] || undefined;
}

export async function promptForApiKey(
  context: vscode.ExtensionContext,
  initialProvider?: LLMProviderId,
): Promise<boolean> {
  const provider = initialProvider ?? (await chooseProvider());
  if (!provider) {
    return false;
  }

  const definition = PROVIDERS[provider];
  const key = await vscode.window.showInputBox({
    title: t('auth.keyTitle'),
    prompt: t('auth.keyPrompt', { provider: definition.label }),
    password: true,
    ignoreFocusOut: true,
    validateInput: validateKey,
  });
  if (key === undefined || validateKey(key) !== undefined) {
    return false;
  }

  await context.secrets.store(definition.secretId, key.trim());
  vscode.window.showInformationMessage(t('auth.keySaved', { provider: definition.label }));
  return true;
}

export async function deleteApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const provider = await chooseProvider();
  if (!provider) {
    return false;
  }

  const definition = PROVIDERS[provider];
  await context.secrets.delete(definition.secretId);
  const environmentNotice = process.env[definition.environmentVariable]
    ? ` ${t('auth.keyEnvironmentFallback', { variable: definition.environmentVariable })}`
    : '';
  vscode.window.showInformationMessage(`${t('auth.keyDeleted')}${environmentNotice}`);
  return true;
}

export async function migrateLegacyLlmConfig(context: vscode.ExtensionContext): Promise<void> {
  const workspaceConfiguration = vscode.workspace.getConfiguration('onewriter');
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (context.globalState.get<number>(MIGRATION_KEY, 0) < MIGRATION_VERSION) {
    await copyLegacyClaudeSecret(context);
    await migrateScope(workspaceConfiguration, vscode.ConfigurationTarget.Global);
    await context.globalState.update(MIGRATION_KEY, MIGRATION_VERSION);
  }

  await migrateScope(workspaceConfiguration, vscode.ConfigurationTarget.Workspace);
  for (const folder of folders) {
    await migrateScope(
      vscode.workspace.getConfiguration('onewriter', folder.uri),
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }
}

async function chooseProvider(): Promise<LLMProviderId | undefined> {
  const selected = await vscode.window.showQuickPick(
    Object.entries(PROVIDERS).map(([value, definition]) => ({
      label: definition.label,
      value: value as LLMProviderId,
    })),
    {
      title: t('auth.selectProviderTitle'),
      placeHolder: t('auth.selectProviderPlaceholder'),
      ignoreFocusOut: true,
    },
  );
  return selected?.value;
}

async function copyLegacyClaudeSecret(context: vscode.ExtensionContext): Promise<void> {
  const newSecretId = PROVIDERS.claude.secretId;
  if (await context.secrets.get(newSecretId)) {
    return;
  }

  const legacySecret = await context.secrets.get(LEGACY_ANTHROPIC_SECRET);
  if (!legacySecret) {
    return;
  }

  await context.secrets.store(newSecretId, legacySecret);
  const copiedSecret = await context.secrets.get(newSecretId);
  if (copiedSecret !== legacySecret) {
    throw new Error('SecretStorage did not persist the migrated API key.');
  }
}

async function migrateScope(
  configuration: vscode.WorkspaceConfiguration,
  target: vscode.ConfigurationTarget,
): Promise<void> {
  const legacyProvider = explicitSetting<string>(configuration, 'llm.provider', target);
  const legacyModel = explicitSetting<string>(configuration, 'llm.apiModel', target);

  if (legacyProvider?.value === 'api') {
    await configuration.update('llm.provider', 'claude', target);
  } else if (legacyProvider?.value === 'cli') {
    await configuration.update('llm.provider', 'gemini', target);
  }

  if (legacyModel && !explicitSetting<string>(configuration, 'llm.claude.model', target)) {
    await configuration.update('llm.claude.model', legacyModel.value, target);
  }
}

function explicitSetting<T>(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  target: vscode.ConfigurationTarget,
): ExplicitSetting<T> | undefined {
  const inspected = configuration.inspect<T>(key);
  if (!inspected) {
    return undefined;
  }
  const value = valueAtTarget(inspected, target);
  return value === undefined ? undefined : { value, target };
}

function valueAtTarget<T>(
  inspected: InspectedSetting<T>,
  target: vscode.ConfigurationTarget,
): T | undefined {
  switch (target) {
    case vscode.ConfigurationTarget.WorkspaceFolder:
      return inspected.workspaceFolderValue;
    case vscode.ConfigurationTarget.Workspace:
      return inspected.workspaceValue;
    case vscode.ConfigurationTarget.Global:
      return inspected.globalValue;
  }
}
