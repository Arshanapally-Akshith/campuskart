import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';
import { getAuthState } from './authStore';

// Module scope, not component scope (BUILD.md Phase 6 "Watch": React
// StrictMode double-mounts effects in dev and would open two sockets
// otherwise). `autoConnect: false` — connection lifecycle is driven by
// ChatContext reacting to auth state, not by socket.io's own default.
//
// `auth` as a thunk (re-invoked on every connection *and* reconnection
// attempt) means a reconnect after the access token has rotated picks up
// the fresh token automatically, rather than replaying whatever was live
// at the moment the socket was first constructed.
export const socket: Socket = io(API_URL, {
  autoConnect: false,
  auth: (cb) => {
    cb({ token: getAuthState().accessToken ?? undefined });
  },
});

export function connectSocket(): void {
  if (!socket.connected) {
    socket.connect();
  }
}

export function disconnectSocket(): void {
  if (socket.connected || socket.active) {
    socket.disconnect();
  }
}
