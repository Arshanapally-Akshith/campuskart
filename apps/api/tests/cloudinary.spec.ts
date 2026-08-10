import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CloudinaryModule from '../src/lib/cloudinary.js';

// This file exercises the real cloudinary.js module (unlike
// thumbnailProcessor.spec.ts, which mocks it away) specifically to prove
// its "not configured" guard. vitest.config.ts sets real (dummy)
// CLOUDINARY_* vars for the whole suite, so getting an "unconfigured"
// module instance requires stubbing the env vars and forcing a fresh
// module evaluation — resetModules + a dynamic import scoped to just this
// module and its side-effect-free dependencies (env.js, errorHandler.js,
// the cloudinary SDK itself), so it can't disturb the shared Mongo/Redis
// singletons other test files rely on.

async function importUnconfigured(): Promise<typeof CloudinaryModule> {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', '');
  vi.stubEnv('CLOUDINARY_API_KEY', '');
  vi.stubEnv('CLOUDINARY_API_SECRET', '');
  vi.resetModules();
  return import('../src/lib/cloudinary.js');
}

describe('Cloudinary — unconfigured (no CLOUDINARY_* env vars)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('config.ts reports isCloudinaryConfigured: false', async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', '');
    vi.stubEnv('CLOUDINARY_API_KEY', '');
    vi.stubEnv('CLOUDINARY_API_SECRET', '');
    vi.resetModules();
    const { isCloudinaryConfigured } = await import('../src/config/env.js');
    expect(isCloudinaryConfigured).toBe(false);
  });

  it('signUploadParams throws a 503 SERVICE_UNAVAILABLE AppError', async () => {
    const { signUploadParams } = await importUnconfigured();
    expect(() => signUploadParams({ foo: 'bar' })).toThrow(
      'Image uploads are not configured on this server',
    );
    try {
      signUploadParams({ foo: 'bar' });
      throw new Error('expected signUploadParams to throw');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  it('uploadThumbnail rejects with the same configuration error', async () => {
    const { uploadThumbnail } = await importUnconfigured();
    await expect(uploadThumbnail(Buffer.from('x'), 'listings/x/y')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('destroyAsset rejects with the same configuration error', async () => {
    const { destroyAsset } = await importUnconfigured();
    await expect(destroyAsset('listings/x/y')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('listResourcesByPrefix rejects with the same configuration error', async () => {
    const { listResourcesByPrefix } = await importUnconfigured();
    await expect(listResourcesByPrefix('listings/', null)).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('destroyAssets rejects with the same configuration error for a non-empty list', async () => {
    const { destroyAssets } = await importUnconfigured();
    await expect(destroyAssets(['listings/x/y'])).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('destroyAssets no-ops on an empty list without needing configuration', async () => {
    const { destroyAssets } = await importUnconfigured();
    await expect(destroyAssets([])).resolves.toBeUndefined();
  });
});

describe('Cloudinary — configured (vitest.config.ts test env)', () => {
  it('config.ts reports isCloudinaryConfigured: true', async () => {
    const { isCloudinaryConfigured } = await import('../src/config/env.js');
    expect(isCloudinaryConfigured).toBe(true);
  });

  it('signUploadParams still signs normally', async () => {
    const { signUploadParams } = await import('../src/lib/cloudinary.js');
    expect(typeof signUploadParams({ timestamp: 1, public_id: 'x' })).toBe('string');
  });
});
