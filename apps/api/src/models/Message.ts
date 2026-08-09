import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    // Per-conversation, strictly increasing — allocated atomically via
    // `$inc: { lastSeq: 1 }` on the parent conversation (ARCHITECTURE.md
    // §5). Not gapless: a crash between allocation and insert leaves a
    // gap, which is harmless for ordering and for `seq > lastSeq` backfill.
    seq: { type: Number, required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // UUID from the client — the idempotency key for retries after a
    // dropped ack. See the unique index below.
    clientMsgId: { type: String, required: true },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ conversationId: 1, seq: -1 });
messageSchema.index({ conversationId: 1, clientMsgId: 1 }, { unique: true });

export type MessageDocument = HydratedDocument<InferSchemaType<typeof messageSchema>>;

export const Message = model('Message', messageSchema);
