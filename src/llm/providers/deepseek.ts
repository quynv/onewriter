import { OpenAICompatibleChatProvider } from './openai-compatible';

export class DeepSeekProvider extends OpenAICompatibleChatProvider {
  constructor(apiKey: string, model: string) {
    super({
      provider: 'deepseek',
      apiKey,
      model,
      endpoint: 'https://api.deepseek.com/chat/completions',
    });
  }
}
