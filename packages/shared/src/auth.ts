/**
 * Basic format sanity check, not a domain gate — signup previously
 * restricted to @student.nitw.ac.in (see ARCHITECTURE.md §8); that
 * restriction was lifted so a recruiter/anyone can sign up for a public
 * demo deployment. Still worth rejecting obviously-malformed input before
 * it reaches the DB.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * A single public, pre-seeded account (see apps/api/scripts/seedDemo.ts)
 * so a recruiter can explore CampusKart with one click — no real email, no
 * OTP. Intentionally not a secret: these are exported for the frontend's
 * "Try Demo" button to use directly, exactly like the credentials printed
 * on the login screen of any public demo app. Never reuse this password
 * for anything that isn't this specific seeded account.
 */
export const DEMO_ACCOUNT_EMAIL = 'demo@campuskart.dev';
export const DEMO_ACCOUNT_PASSWORD = 'CampusKartDemo@2026';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface SignupRequest {
  email: string;
  password: string;
  name: string;
}

export interface SignupResponse {
  email: string;
  otpSent: true;
}

export interface VerifyOtpRequest {
  email: string;
  otp: string;
}

export interface VerifyOtpResponse {
  verified: true;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: AuthUser;
  accessToken: string;
}

export interface RefreshResponse {
  user: AuthUser;
  accessToken: string;
}

export interface MeResponse {
  user: AuthUser;
}
