import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const conversationSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
    // [buyerId, sellerId] sorted lexicographically — order-independent so the
    // same pair always produces the same `participantsKey` regardless of who
    // initiated. ARCHITECTURE.md §3.3.
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length === 2,
        message: 'participants must contain exactly two users',
      },
    },
    // Deviation from the literal ARCHITECTURE.md index spec, documented
    // here: a *multikey* unique index on `{ listingId, participants }`
    // does not enforce "one conversation per (listing, buyer, seller)
    // pair" the way it reads — it enforces uniqueness per individual
    // array element, so the seller (present in every conversation for
    // their own listing) would collide across the *first* two buyers who
    // ever messaged them, making a second buyer's conversation
    // uninsertable. `participantsKey` is a derived scalar
    // (`sortedId1_sortedId2`) that gets the real, intended uniqueness.
    participantsKey: { type: String, required: true },
    lastSeq: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: '' },
    // `{ [userId]: lastReadSeq }` — Mixed like `Listing.attributes`, since
    // it's read/written through dotted-path atomic updates
    // (`reads.<userId>`), not queried on its own.
    reads: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

conversationSchema.index({ listingId: 1, participantsKey: 1 }, { unique: true });
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export type ConversationDocument = HydratedDocument<InferSchemaType<typeof conversationSchema>>;

export const Conversation = model('Conversation', conversationSchema);
