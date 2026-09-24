import type { LLMProviderId } from './providers/types';

export type LLMErrorKind = 'auth' | 'quota' | 'timeout' | 'model' | 'configuration' | 'parse' | 'network' | 'other';

export interface LLMErrorDetails {
  provider?: LLMProviderId;
  model?: string;
  status?: number;
}

/**
 * Phân biệt hai loại thất bại. Lỗi parse thì retry có ích, còn lỗi xác thực hay
 * hết quota thì retry chỉ tốn thêm một lần gọi và làm mất thông báo gốc.
 */
export class LLMError extends Error {
  readonly provider?: LLMProviderId;
  readonly model?: string;
  readonly status?: number;

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: LLMErrorKind = 'other',
    details: LLMErrorDetails = {},
  ) {
    super(message);
    this.name = 'LLMError';
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
  }
}
