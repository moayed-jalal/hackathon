export const ERROR_CODES = {
  INVALID_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INVALID_API_KEY: 401,
  INVALID_SIGNATURE: 401,
  STALE_TIMESTAMP: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_SCOPE: 403,
  NOT_FOUND: 404,
  INVALID_STATE_TRANSITION: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  DUPLICATE_EVENT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Thrown by route/service code; caught centrally by middleware/errorHandler.ts. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }
}
