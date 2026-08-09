import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { NITW_EMAIL_REGEX } from '@campuskart/shared';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: NITW_EMAIL_REGEX,
    },
    emailVerifiedAt: { type: Date, default: null },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    hostel: { type: String, default: null },
    phone: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    strikes: { type: Number, default: 0 },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  },
  { timestamps: true },
);

export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const User = model('User', userSchema);
