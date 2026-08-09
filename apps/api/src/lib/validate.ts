import { ErrorCode, isNitwEmail } from '@campuskart/shared';
import { AppError } from '../middleware/errorHandler.js';

export function requireString(body: unknown, field: string): string {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Request body must be a JSON object');
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Missing or invalid field: ${field}`);
  }
  return value;
}

export function assertNitwEmail(email: string): void {
  if (!isNitwEmail(email)) {
    throw new AppError(
      400,
      ErrorCode.BAD_REQUEST,
      'Signup is restricted to @student.nitw.ac.in addresses',
    );
  }
}

export function assertPasswordStrength(password: string): void {
  if (password.length < 8 || password.length > 72) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Password must be between 8 and 72 characters');
  }
}

export function assertNameLength(name: string): void {
  if (name.length < 1 || name.length > 100) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Name must be between 1 and 100 characters');
  }
}

export function assertOtpFormat(otp: string): void {
  if (!/^\d{6}$/.test(otp)) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'OTP must be 6 digits');
  }
}
