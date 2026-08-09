import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  MAX_IMAGES_PER_LISTING,
  MAX_IMAGE_BYTES,
  MIME_TO_CLOUDINARY_FORMAT,
  signUploadRequestSchema,
  type SignUploadResponse,
} from '@campuskart/shared';
import { Router, type Router as RouterType } from 'express';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { signUploadParams } from '../lib/cloudinary.js';
import { AppError } from '../middleware/errorHandler.js';
import { getAuthUser, requireAuth } from '../middleware/requireAuth.js';
import { Listing } from '../models/Listing.js';

export const uploadsRouter: RouterType = Router();

uploadsRouter.post(
  '/sign',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { listingId, mimeType } = signUploadRequestSchema.parse(req.body);

    const listing = await Listing.findById(listingId);
    if (!listing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (listing.sellerId.toString() !== actorId) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }
    if (listing.status === 'REMOVED') {
      throw new AppError(409, ErrorCode.CONFLICT, 'Cannot add images to a removed listing');
    }
    if (listing.images.length >= MAX_IMAGES_PER_LISTING) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        `A listing may have at most ${String(MAX_IMAGES_PER_LISTING)} images`,
      );
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `listings/${listingId}/${randomUUID()}`;
    const allowedFormats = MIME_TO_CLOUDINARY_FORMAT[mimeType];

    // Every non-file param sent to Cloudinary's upload endpoint must appear
    // here, or Cloudinary rejects the upload as an invalid signature — this
    // is also what makes `allowed_formats` an enforced constraint rather
    // than a client-trusted hint: Cloudinary checks the real bytes against
    // it on their end.
    const paramsToSign = { timestamp, public_id: publicId, allowed_formats: allowedFormats };
    const signature = signUploadParams(paramsToSign);

    const body: SignUploadResponse = {
      cloudName: env.cloudinaryCloudName,
      apiKey: env.cloudinaryApiKey,
      timestamp,
      signature,
      publicId,
      allowedFormats,
      maxFileSizeBytes: MAX_IMAGE_BYTES,
    };
    res.status(200).json(body);
  }),
);
