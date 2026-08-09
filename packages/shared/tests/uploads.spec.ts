import { describe, expect, it } from 'vitest';
import { reorderImagesRequestSchema, signUploadRequestSchema } from '../src/uploads.js';

describe('signUploadRequestSchema', () => {
  it('accepts an allowed mime type', () => {
    expect(
      signUploadRequestSchema.safeParse({ listingId: 'x', mimeType: 'image/png' }).success,
    ).toBe(true);
  });

  it('rejects a disallowed mime type (ARCHITECTURE.md §7 allowlist)', () => {
    expect(
      signUploadRequestSchema.safeParse({ listingId: 'x', mimeType: 'application/pdf' }).success,
    ).toBe(false);
  });
});

describe('reorderImagesRequestSchema', () => {
  it('rejects an empty publicIds array', () => {
    expect(reorderImagesRequestSchema.safeParse({ publicIds: [] }).success).toBe(false);
  });
});
