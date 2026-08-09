import type {
  AuthUser,
  LoginRequest,
  LoginResponse,
  SignupRequest,
  SignupResponse,
  VerifyOtpRequest,
  VerifyOtpResponse,
} from '@campuskart/shared';
import { clearSession, setSession } from './authStore';
import { http, refreshSession } from './http';

export async function signup(payload: SignupRequest): Promise<SignupResponse> {
  const res = await http.post<SignupResponse>('/api/auth/signup', payload);
  return res.data;
}

export async function verifyOtp(payload: VerifyOtpRequest): Promise<VerifyOtpResponse> {
  const res = await http.post<VerifyOtpResponse>('/api/auth/verify-otp', payload);
  return res.data;
}

export async function login(payload: LoginRequest): Promise<AuthUser> {
  const res = await http.post<LoginResponse>('/api/auth/login', payload);
  setSession(res.data.user, res.data.accessToken);
  return res.data.user;
}

export async function logout(): Promise<void> {
  try {
    await http.post('/api/auth/logout');
  } finally {
    clearSession();
  }
}

/** Attempts to restore a session from the httpOnly refresh cookie on mount. */
export async function bootstrapSession(): Promise<void> {
  try {
    await refreshSession();
  } catch {
    clearSession();
  }
}
