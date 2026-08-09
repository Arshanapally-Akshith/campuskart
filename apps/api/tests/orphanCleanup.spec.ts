import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { CloudinaryResource } from '../src/lib/cloudinary.js';
import { findOrphanedAssets, ORPHAN_MIN_AGE_MS } from '../src/lib/orphanCleanup.js';

vi.mock('../src/lib/cloudinary.js', () => ({
  listResourcesByPrefix: vi.fn(),
  destroyAssets: vi.fn(),
}));

const NOW = new Date('2026-08-09T12:00:00.000Z');

function asset(overrides: Partial<CloudinaryResource> = {}): CloudinaryResource {
  return {
    publicId: 'listings/abc/def',
    createdAt: NOW.toISOString(),
    bytes: 1024,
    ...overrides,
  };
}

describe('findOrphanedAssets', () => {
  it('does not flag an asset referenced by some listing', () => {
    const referenced = new Set(['listings/abc/def']);
    const result = findOrphanedAssets(
      [asset({ createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS * 2).toISOString() })],
      referenced,
      NOW,
    );
    expect(result).toHaveLength(0);
  });

  it('does not flag an unreferenced asset younger than the minimum age', () => {
    const tooYoung = asset({ createdAt: new Date(NOW.getTime() - 1000).toISOString() });
    const result = findOrphanedAssets([tooYoung], new Set(), NOW);
    expect(result).toHaveLength(0);
  });

  it('flags an unreferenced asset older than the minimum age', () => {
    const old = asset({
      publicId: 'listings/xyz/orphan',
      createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 1000).toISOString(),
    });
    const result = findOrphanedAssets([old], new Set(), NOW);
    expect(result).toEqual([old]);
  });

  it('never flags a derived thumbnail asset, even if unreferenced and old', () => {
    const oldThumb = asset({
      publicId: 'listings/xyz/orphan_thumb',
      createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 1000).toISOString(),
    });
    const result = findOrphanedAssets([oldThumb], new Set(), NOW);
    expect(result).toHaveLength(0);
  });

  it('respects a custom minAgeMs override', () => {
    const fiveMinutesOld = asset({
      createdAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
    });
    expect(findOrphanedAssets([fiveMinutesOld], new Set(), NOW, 60 * 1000)).toEqual([
      fiveMinutesOld,
    ]);
    expect(findOrphanedAssets([fiveMinutesOld], new Set(), NOW, 60 * 60 * 1000)).toHaveLength(0);
  });
});

describe('runOrphanCleanup', () => {
  it('deletes only confirmed orphans and reports counts', async () => {
    const { Listing } = await import('../src/models/Listing.js');
    const { listResourcesByPrefix, destroyAssets } = await import('../src/lib/cloudinary.js');
    const { runOrphanCleanup } = await import('../src/lib/orphanCleanup.js');

    const referencedAsset = asset({ publicId: 'listings/a/referenced' });
    const orphanAsset = asset({
      publicId: 'listings/a/orphan',
      createdAt: new Date(Date.now() - ORPHAN_MIN_AGE_MS - 1000).toISOString(),
    });
    const tooYoungAsset = asset({
      publicId: 'listings/a/fresh',
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });

    vi.mocked(listResourcesByPrefix).mockResolvedValue({
      resources: [referencedAsset, orphanAsset, tooYoungAsset],
      nextCursor: null,
    });
    vi.mocked(destroyAssets).mockResolvedValue(undefined);

    await Listing.create({
      sellerId: new Types.ObjectId(),
      title: 'A perfectly ordinary listing',
      description: 'Long enough description to satisfy the schema minimum length requirement.',
      category: 'OTHER',
      attributes: {},
      priceInPaise: 100,
      condition: 'GOOD',
      status: 'DRAFT',
      images: [
        { publicId: referencedAsset.publicId, url: 'https://example.com/x', width: 1, height: 1 },
      ],
    });

    const result = await runOrphanCleanup();

    expect(destroyAssets).toHaveBeenCalledTimes(1);
    expect(destroyAssets).toHaveBeenCalledWith([orphanAsset.publicId]);
    expect(result).toEqual({ scanned: 3, deleted: 1 });
  });
});
