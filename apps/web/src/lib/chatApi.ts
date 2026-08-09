import type {
  ConversationListItem,
  ConversationsListResponse,
  MessageHistoryResponse,
} from '@campuskart/shared';
import { http } from './http';

export async function getConversations(): Promise<ConversationListItem[]> {
  const res = await http.get<ConversationsListResponse>('/api/conversations');
  return res.data.conversations;
}

export async function createConversation(listingId: string): Promise<ConversationListItem> {
  const res = await http.post<ConversationListItem>('/api/conversations', { listingId });
  return res.data;
}

export interface MessageHistoryParams {
  beforeSeq?: number | undefined;
  limit?: number | undefined;
}

export async function getMessageHistory(
  conversationId: string,
  params: MessageHistoryParams = {},
): Promise<MessageHistoryResponse> {
  const res = await http.get<MessageHistoryResponse>(
    `/api/conversations/${conversationId}/messages`,
    { params },
  );
  return res.data;
}
