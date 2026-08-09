import type { AuthUser } from '@campuskart/shared';

export interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  /** True until the initial silent-refresh-on-mount attempt resolves. */
  bootstrapping: boolean;
}

let state: AuthState = { accessToken: null, user: null, bootstrapping: true };
const listeners = new Set<() => void>();

export function getAuthState(): AuthState {
  return state;
}

export function setAuthState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => {
    listener();
  });
}

export function subscribeAuthState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSession(user: AuthUser, accessToken: string): void {
  setAuthState({ user, accessToken, bootstrapping: false });
}

export function clearSession(): void {
  setAuthState({ user: null, accessToken: null, bootstrapping: false });
}
