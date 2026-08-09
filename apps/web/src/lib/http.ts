import type { AuthUser } from '@campuskart/shared';
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { API_URL } from './api';
import { clearSession, getAuthState, setSession } from './authStore';
import { createSingleFlight } from './singleFlight';

export const http = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

http.interceptors.request.use((config) => {
  const { accessToken } = getAuthState();
  if (accessToken) {
    config.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return config;
});

interface RefreshResponseBody {
  user: AuthUser;
  accessToken: string;
}

// Single-flight across every caller — both the 401 retry path below and the
// initial-mount bootstrap in authApi.bootstrapSession — so React
// StrictMode's double-invoked effect (or several requests failing at once
// after expiry) never fires two /refresh calls for the same cookie. The
// backend's rotation is one-shot: a second concurrent presentation of the
// same refresh token is indistinguishable from reuse and burns the whole
// session (see apps/api/src/routes/auth.ts).
export const refreshSession = createSingleFlight(async (): Promise<string> => {
  const res = await axios.post<RefreshResponseBody>(`${API_URL}/api/auth/refresh`, undefined, {
    withCredentials: true,
  });
  setSession(res.data.user, res.data.accessToken);
  return res.data.accessToken;
});

interface RetriableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;
    const isRefreshCall = config?.url?.includes('/api/auth/refresh') ?? false;

    if (status === 401 && isRefreshCall) {
      clearSession();
      return Promise.reject(error);
    }

    if (status !== 401 || !config || config._retry) {
      return Promise.reject(error);
    }

    config._retry = true;
    try {
      const newToken = await refreshSession();
      config.headers.set('Authorization', `Bearer ${newToken}`);
      return http(config);
    } catch (refreshError) {
      clearSession();
      return Promise.reject(refreshError instanceof Error ? refreshError : error);
    }
  },
);
