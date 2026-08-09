import { REPORT_REASONS } from '@campuskart/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const reportSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, default: null },
    // Not surfaced by any route in this phase (no admin dashboard/moderation
    // UI — BUILD.md Phase 7 reduced scope) — kept only so the schema matches
    // ARCHITECTURE.md §3.6 up front, the same reasoning Listing's
    // reservation block used in Phase 2 ahead of Phase 5.
    status: { type: String, enum: ['OPEN', 'ACTIONED', 'DISMISSED'], default: 'OPEN' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One report per (listing, reporter) — the duplicate-report guard.
reportSchema.index({ listingId: 1, reporterId: 1 }, { unique: true });

export type ReportDocument = HydratedDocument<InferSchemaType<typeof reportSchema>>;

export const Report = model('Report', reportSchema);
