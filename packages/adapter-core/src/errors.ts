import type { AdapterErrorCode, AdapterErrorPayload } from './types.js';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(payload: AdapterErrorPayload) {
    super(payload.message);
    this.name = 'AdapterError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.cause = payload.cause;
  }

  toEvent() {
    return {
      type: 'error' as const,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        cause: this.cause,
      },
    };
  }
}

/** Map common HTTP errors to AdapterErrorCode. */
export function mapHttpStatus(status: number): AdapterErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_5XX';
  if (status >= 400) return 'UPSTREAM_4XX';
  return 'INTERNAL';
}
