import { createHash, randomInt } from 'node:crypto';
import { redis } from './redis.js';

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;

function otpKey(email: string): string {
  return `otp:${email.toLowerCase()}`;
}

function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

interface StoredOtp {
  hash: string;
  attempts: number;
}

export async function storeOtp(email: string, otp: string): Promise<void> {
  const payload: StoredOtp = { hash: hashOtp(otp), attempts: 0 };
  await redis.set(otpKey(email), JSON.stringify(payload), 'EX', OTP_TTL_SECONDS);
}

export type OtpVerifyResult = 'OK' | 'INVALID' | 'EXPIRED' | 'ATTEMPTS_EXCEEDED';

export async function verifyOtp(email: string, candidate: string): Promise<OtpVerifyResult> {
  const key = otpKey(email);
  const raw = await redis.get(key);
  if (!raw) return 'EXPIRED';

  const stored = JSON.parse(raw) as StoredOtp;
  if (stored.attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(key);
    return 'ATTEMPTS_EXCEEDED';
  }

  if (stored.hash !== hashOtp(candidate)) {
    const nextAttempts = stored.attempts + 1;
    if (nextAttempts >= OTP_MAX_ATTEMPTS) {
      await redis.del(key);
      return 'ATTEMPTS_EXCEEDED';
    }
    // Read-modify-write on the attempt counter is good enough here: unlike a
    // reservation, losing a race just costs the caller one extra guess, not
    // a double-sell. KEEPTTL preserves the original 10-minute expiry.
    await redis.set(
      key,
      JSON.stringify({ ...stored, attempts: nextAttempts } satisfies StoredOtp),
      'KEEPTTL',
    );
    return 'INVALID';
  }

  await redis.del(key);
  return 'OK';
}

export async function clearOtp(email: string): Promise<void> {
  await redis.del(otpKey(email));
}
