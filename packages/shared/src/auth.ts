/** Signup is gated to this domain — see ARCHITECTURE.md §8. */
export const NITW_EMAIL_REGEX = /^[^\s@]+@student\.nitw\.ac\.in$/i;

export function isNitwEmail(email: string): boolean {
  return NITW_EMAIL_REGEX.test(email);
}

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
