import { MAX_IMAGE_BYTES, THUMBNAIL_WIDTH } from '@campuskart/shared';
import sharp, { type Metadata } from 'sharp';
import { destroyAsset, fetchImageBuffer, uploadThumbnail } from './cloudinary.js';
import { logger } from './logger.js';
import type { ThumbnailJobData } from './thumbnailQueue.js';
import { Listing } from '../models/Listing.js';

const RECOGNIZED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/**
 * A permanent rejection — the bytes are not (or are no longer) a real,
 * allowed image. Retrying won't change that, unlike a network blip, so the
 * caller must NOT rethrow this into BullMQ's retry path.
 */
export class InvalidImageError extends Error {}

/**
 * Verifies the bytes are a genuine image via sharp's own decoder — not the
 * declared Content-Type or file extension — and produces a resized
 * thumbnail. This is what catches `evil.exe` renamed to `.jpg`: sharp
 * fails to parse real image headers from arbitrary binary data.
 */
export async function verifyAndGenerateThumbnail(buffer: Buffer): Promise<Buffer> {
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new InvalidImageError(
      `Image is ${String(buffer.byteLength)} bytes, over the ${String(MAX_IMAGE_BYTES)} byte limit`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new InvalidImageError('File is not a valid image (sharp could not parse it)');
  }

  if (!metadata.format || !RECOGNIZED_FORMATS.has(metadata.format)) {
    throw new InvalidImageError(
      `Unrecognized or disallowed image format: ${String(metadata.format)}`,
    );
  }

  return sharp(buffer)
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export async function processThumbnailJob(data: ThumbnailJobData): Promise<void> {
  const buffer = await fetchImageBuffer(data.url);

  let thumbBuffer: Buffer;
  try {
    thumbBuffer = await verifyAndGenerateThumbnail(buffer);
  } catch (err) {
    if (err instanceof InvalidImageError) {
      // Not retryable: the file itself is the problem. Drop it from the
      // listing and best-effort clean up the bad asset on Cloudinary,
      // rather than burning 3 retries re-fetching the same bad bytes.
      await Listing.updateOne(
        { _id: data.listingId },
        { $pull: { images: { publicId: data.publicId } } },
      );
      await destroyAsset(data.publicId).catch((destroyErr: unknown) => {
        logger.warn(
          { err: destroyErr, publicId: data.publicId },
          'Failed to clean up rejected image asset on Cloudinary',
        );
      });
      logger.warn(
        { listingId: data.listingId, publicId: data.publicId, reason: err.message },
        'Rejected upload: not a valid image',
      );
      return;
    }
    throw err; // transient/unexpected — let BullMQ retry.
  }

  const thumbPublicId = `${data.publicId}_thumb`;
  const thumbUrl = await uploadThumbnail(thumbBuffer, thumbPublicId);

  const result = await Listing.updateOne(
    { _id: data.listingId, 'images.publicId': data.publicId },
    { $set: { 'images.$.thumbUrl': thumbUrl } },
  );
  if (result.matchedCount === 0) {
    // Listing or image was deleted while the job was in flight.
    logger.info(
      { listingId: data.listingId, publicId: data.publicId },
      'Listing/image no longer exists; discarding generated thumbnail',
    );
  }
}
