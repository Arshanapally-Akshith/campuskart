import type { AuthUser } from '@campuskart/shared';
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import * as authApi from '../lib/authApi';
import { getAuthState, subscribeAuthState } from '../lib/authStore';

interface AuthContextValue {
  user: AuthUser | null;
  /** True until the initial silent-refresh-on-mount attempt resolves. */
  bootstrapping: boolean;
  isAuthenticated: boolean;
  signup: typeof authApi.signup;
  verifyOtp: typeof authApi.verifyOtp;
  login: typeof authApi.login;
  logout: typeof authApi.logout;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeAuthState, getAuthState);

  useEffect(() => {
    void authApi.bootstrapSession();
  }, []);

  const value: AuthContextValue = {
    user: state.user,
    bootstrapping: state.bootstrapping,
    isAuthenticated: state.user !== null,
    signup: authApi.signup,
    verifyOtp: authApi.verifyOtp,
    login: authApi.login,
    logout: authApi.logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
