import { z } from 'zod';

/** ARCHITECTURE.md §7: authed, mime allowlist, ≤5MB, ≤6 images per listing. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_LISTING = 6;
export const THUMBNAIL_WIDTH = 320;

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const MIME_TO_CLOUDINARY_FORMAT: Record<AllowedImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const signUploadRequestSchema = z.object({
  listingId: z.string().min(1),
  mimeType: z.enum(ALLOWED_IMAGE_MIME_TYPES),
});
export type SignUploadRequest = z.infer<typeof signUploadRequestSchema>;

export interface SignUploadResponse {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  publicId: string;
  allowedFormats: string;
  maxFileSizeBytes: number;
}

export const attachImageRequestSchema = z.object({
  publicId: z.string().min(1),
  url: z.url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AttachImageRequest = z.infer<typeof attachImageRequestSchema>;

export const removeImageRequestSchema = z.object({
  publicId: z.string().min(1),
});
export type RemoveImageRequest = z.infer<typeof removeImageRequestSchema>;

export const reorderImagesRequestSchema = z.object({
  publicIds: z.array(z.string().min(1)).min(1),
});
export type ReorderImagesRequest = z.infer<typeof reorderImagesRequestSchema>;
