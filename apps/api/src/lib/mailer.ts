import { logger } from './logger.js';

/**
 * Dev: log to console (per BUILD.md Phase 1). Swap for Resend/SES in prod —
 * same signature, so callers never change.
 */
export function sendOtpEmail(email: string, otp: string): void {
  logger.info({ email, otp }, `[dev-mailer] OTP for ${email}: ${otp}`);
}
