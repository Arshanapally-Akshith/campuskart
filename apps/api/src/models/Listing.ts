import { CATEGORIES, CONDITIONS, LISTING_STATUSES } from '@campuskart/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const listingImageSchema = new Schema(
  {
    publicId: { type: String, required: true },
    url: { type: String, required: true },
    // Null until the thumbnail worker (Phase 3) processes the upload.
    thumbUrl: { type: String, default: null },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
  },
  { _id: false },
);

const listingSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, minlength: 5, maxlength: 100 },
    description: { type: String, required: true, trim: true, minlength: 20, maxlength: 2000 },
    category: { type: String, enum: CATEGORIES, required: true },
    // Category-specific and Zod-validated per category at the API boundary
    // (packages/shared/src/listings.ts) — Mongoose stores it as the
    // flexible bag the architecture calls for.
    attributes: { type: Schema.Types.Mixed, default: {} },
    priceInPaise: { type: Number, required: true, min: 1 },
    condition: { type: String, enum: CONDITIONS, required: true },
    images: { type: [listingImageSchema], default: [] },
    status: { type: String, enum: LISTING_STATUSES, default: 'DRAFT' },

    // Reservation block — only meaningful when status === 'RESERVED'.
    // Populated starting in Phase 5; present now so the schema matches
    // ARCHITECTURE.md §3.2 up front.
    reservedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reservedAt: { type: Date, default: null },
    reservationExpiresAt: { type: Date, default: null },

    soldTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    soldAt: { type: Date, default: null },

    version: { type: Number, default: 0 },
    reportCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

listingSchema.index({ status: 1, createdAt: -1, _id: -1 }); // feed + cursor pagination
listingSchema.index({ status: 1, category: 1, priceInPaise: 1, createdAt: -1 }); // filtered browse
listingSchema.index({ sellerId: 1, createdAt: -1 }); // "my listings"
listingSchema.index({ title: 'text', description: 'text' }); // search
listingSchema.index(
  { status: 1, reservationExpiresAt: 1 },
  { partialFilterExpression: { status: 'RESERVED' } }, // sweeper
);

export type ListingDocument = HydratedDocument<InferSchemaType<typeof listingSchema>>;

export const Listing = model('Listing', listingSchema);
