import {
  createConversationRequestSchema,
  HISTORY_DEFAULT_LIMIT,
  messageHistoryQuerySchema,
  type ConversationsListResponse,
  type MessageHistoryResponse,
} from '@campuskart/shared';
import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  assertParticipant,
  getConversationOrThrow,
  getMessagesBefore,
  getOrCreateConversation,
  listConversationsForUser,
  toConversationListItem,
  toMessageDto,
} from '../lib/chatService.js';
import { getAuthUser, requireAuth } from '../middleware/requireAuth.js';

export const conversationsRouter: RouterType = Router();

conversationsRouter.use(requireAuth);

conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { sub: userId } = getAuthUser(req);
    const conversations = await listConversationsForUser(userId);
    const body: ConversationsListResponse = {
      conversations: conversations.map((conv) => toConversationListItem(conv, userId)),
    };
    res.status(200).json(body);
  }),
);

conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { sub: userId } = getAuthUser(req);
    const { listingId } = createConversationRequestSchema.parse(req.body);
    const conv = await getOrCreateConversation(listingId, userId);
    res.status(200).json(toConversationListItem(conv, userId));
  }),
);

// REST history endpoint — ARCHITECTURE.md §5: `sync` over the socket is the
// live-reconnect path capped at SYNC_PAGE_CAP; this is scrollback for gaps
// or history longer than that cap, driven by `?beforeSeq&limit`.
conversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const { sub: userId } = getAuthUser(req);
    const { id } = req.params;
    const query = messageHistoryQuerySchema.parse(req.query);

    const conv = await getConversationOrThrow(id ?? '');
    assertParticipant(conv, userId);

    const { messages, hasMore } = await getMessagesBefore(
      conv._id.toString(),
      query.beforeSeq,
      query.limit ?? HISTORY_DEFAULT_LIMIT,
    );
    const body: MessageHistoryResponse = { messages: messages.map(toMessageDto), hasMore };
    res.status(200).json(body);
  }),
);
