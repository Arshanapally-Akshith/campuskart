import { SocketEvent, type MessageDto } from '@campuskart/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { connectSocket, disconnectSocket, socket } from '../lib/socket';
import { useAuth } from './AuthContext';

/**
 * Owns the one module-scope socket's connect/disconnect lifecycle (BUILD.md
 * Phase 6 "Watch") and the one cross-cutting side effect every screen needs
 * regardless of which conversation (if any) is open: a new message anywhere
 * should refresh the conversation list's unread badges and previews.
 * Per-conversation concerns (history, optimistic send, typing) live in
 * `useConversationChat`, scoped to whichever chat panel is mounted.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isAuthenticated) {
      disconnectSocket();
      return;
    }
    connectSocket();
    return () => {
      disconnectSocket();
    };
  }, [isAuthenticated]);

  useEffect(() => {
    function handleMessageNew(_message: MessageDto): void {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
    socket.on(SocketEvent.MESSAGE_NEW, handleMessageNew);
    return () => {
      socket.off(SocketEvent.MESSAGE_NEW, handleMessageNew);
    };
  }, [queryClient]);

  return <>{children}</>;
}
