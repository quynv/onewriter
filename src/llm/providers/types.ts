import type * as vscode from 'vscode';

export const LLM_PROVIDER_IDS = ['gemini', 'openai', 'qwen', 'deepseek', 'claude'] as const;
export type LLMProviderId = (typeof LLM_PROVIDER_IDS)[number];

export interface ProviderDefinition {
  label: string;
  defaultModel: string;
  modelSetting: `llm.${LLMProviderId}.model`;
  secretId: `onewriter.apiKey.${LLMProviderId}`;
  environmentVariable: string;
}

export const PROVIDERS: Record<LLMProviderId, ProviderDefinition> = {
  gemini: {
    label: 'Gemini',
    defaultModel: 'gemini-3.8-flash',
    modelSetting: 'llm.gemini.model',
    secretId: 'onewriter.apiKey.gemini',
    environmentVariable: 'GEMINI_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.6-luna',
    modelSetting: 'llm.openai.model',
    secretId: 'onewriter.apiKey.openai',
    environmentVariable: 'OPENAI_API_KEY',
  },
  qwen: {
    label: 'Qwen',
    defaultModel: 'qwen3.8-max',
    modelSetting: 'llm.qwen.model',
    secretId: 'onewriter.apiKey.qwen',
    environmentVariable: 'DASHSCOPE_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    modelSetting: 'llm.deepseek.model',
    secretId: 'onewriter.apiKey.deepseek',
    environmentVariable: 'DEEPSEEK_API_KEY',
  },
  claude: {
    label: 'Claude',
    defaultModel: 'claude-sonnet-4-6',
    modelSetting: 'llm.claude.model',
    secretId: 'onewriter.apiKey.claude',
    environmentVariable: 'ANTHROPIC_API_KEY',
  },
};

export function isProviderId(value: unknown): value is LLMProviderId {
  return typeof value === 'string' && LLM_PROVIDER_IDS.includes(value as LLMProviderId);
}

export function getProviderModel(
  configuration: vscode.WorkspaceConfiguration,
  provider: LLMProviderId,
): string {
  const definition = PROVIDERS[provider];
  return configuration.get<string>(definition.modelSetting, definition.defaultModel);
}
