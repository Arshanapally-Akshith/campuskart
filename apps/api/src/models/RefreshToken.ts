import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';

const refreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  familyId: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  replacedBy: { type: Schema.Types.ObjectId, ref: 'RefreshToken', default: null },
  userAgent: { type: String, default: null },
  ip: { type: String, default: null },
});

// Unlike the reservation state machine (ARCHITECTURE.md §4), a TTL index is
// correct here: an expired token has no further state to transition through,
// it just needs to be gone. expireAfterSeconds: 0 expires at the stored
// `expiresAt` instant rather than N seconds after document creation.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ familyId: 1 });

export type RefreshTokenDocument = HydratedDocument<InferSchemaType<typeof refreshTokenSchema>>;
export type RefreshTokenId = Types.ObjectId;

export const RefreshToken = model('RefreshToken', refreshTokenSchema);
