/** Machine-readable error codes. Clients branch on `code`, never on `message` text. */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  INVALID_OTP: 'INVALID_OTP',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
