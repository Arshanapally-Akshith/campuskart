import type { ErrorCode, ErrorPayload } from '@campuskart/shared';
import axios from 'axios';

export function getErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as Partial<ErrorPayload> | undefined;
    if (data?.error?.message) {
      return data.error.message;
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

export function getErrorCode(err: unknown): ErrorCode | null {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as Partial<ErrorPayload> | undefined;
    return data?.error?.code ?? null;
  }
  return null;
}
