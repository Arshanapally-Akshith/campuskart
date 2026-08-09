import { MAX_IMAGE_BYTES } from '@campuskart/shared';
import { Types } from 'mongoose';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/cloudinary.js', () => ({
  fetchImageBuffer: vi.fn(),
  uploadThumbnail: vi.fn(),
  destroyAsset: vi.fn(),
}));

async function createTestImage(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}

describe('verifyAndGenerateThumbnail', () => {
  it('produces a 320px-wide jpeg thumbnail from a genuine image', async () => {
    const { verifyAndGenerateThumbnail } = await import('../src/lib/thumbnailProcessor.js');
    const original = await createTestImage(800, 600);

    const thumb = await verifyAndGenerateThumbnail(original);
    const metadata = await sharp(thumb).metadata();

    expect(metadata.width).toBe(320);
    expect(metadata.format).toBe('jpeg');
  });

  it('rejects a renamed non-image file (evil.exe as .jpg)', async () => {
    const { verifyAndGenerateThumbnail, InvalidImageError } =
      await import('../src/lib/thumbnailProcessor.js');
    // Not image bytes at all — the whole point is that sharp can't be
    // fooled by a filename or a declared Content-Type.
    const fakeImage = Buffer.from('MZ this is actually an executable, not a jpeg', 'utf8');

    await expect(verifyAndGenerateThumbnail(fakeImage)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it('rejects a file over the size limit before ever parsing it', async () => {
    const { verifyAndGenerateThumbnail, InvalidImageError } =
      await import('../src/lib/thumbnailProcessor.js');
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);

    await expect(verifyAndGenerateThumbnail(oversized)).rejects.toBeInstanceOf(InvalidImageError);
  });
});

describe('processThumbnailJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('patches listing.images[].thumbUrl on a valid image', async () => {
    const { Listing } = await import('../src/models/Listing.js');
    const { fetchImageBuffer, uploadThumbnail } = await import('../src/lib/cloudinary.js');
    const { processThumbnailJob } = await import('../src/lib/thumbnailProcessor.js');

    const publicId = 'listings/abc/real-image';
    const listing = await Listing.create({
      sellerId: new Types.ObjectId(),
      title: 'A perfectly ordinary listing',
      description: 'Long enough description to satisfy the schema minimum length requirement.',
      category: 'OTHER',
      attributes: {},
      priceInPaise: 100,
      condition: 'GOOD',
      status: 'DRAFT',
      images: [{ publicId, url: 'https://example.com/real.jpg', width: 800, height: 600 }],
    });

    vi.mocked(fetchImageBuffer).mockResolvedValue(await createTestImage());
    vi.mocked(uploadThumbnail).mockResolvedValue('https://example.com/real_thumb.jpg');

    await processThumbnailJob({
      listingId: listing._id.toString(),
      publicId,
      url: 'https://example.com/real.jpg',
    });

    const updated = await Listing.findById(listing._id);
    expect(updated?.images[0]?.thumbUrl).toBe('https://example.com/real_thumb.jpg');
  });

  it('removes the image and cleans up the asset when the file is not a real image', async () => {
    const { Listing } = await import('../src/models/Listing.js');
    const { fetchImageBuffer, destroyAsset } = await import('../src/lib/cloudinary.js');
    const { processThumbnailJob } = await import('../src/lib/thumbnailProcessor.js');

    const publicId = 'listings/abc/fake-image';
    const listing = await Listing.create({
      sellerId: new Types.ObjectId(),
      title: 'A perfectly ordinary listing',
      description: 'Long enough description to satisfy the schema minimum length requirement.',
      category: 'OTHER',
      attributes: {},
      priceInPaise: 100,
      condition: 'GOOD',
      status: 'DRAFT',
      images: [{ publicId, url: 'https://example.com/fake.jpg', width: 800, height: 600 }],
    });

    vi.mocked(fetchImageBuffer).mockResolvedValue(Buffer.from('not an image'));
    vi.mocked(destroyAsset).mockResolvedValue(undefined);

    await processThumbnailJob({
      listingId: listing._id.toString(),
      publicId,
      url: 'https://example.com/fake.jpg',
    });

    const updated = await Listing.findById(listing._id);
    expect(updated?.images).toHaveLength(0);
    expect(destroyAsset).toHaveBeenCalledWith(publicId);
  });

  it('rethrows on a transient fetch failure so BullMQ retries', async () => {
    const { fetchImageBuffer } = await import('../src/lib/cloudinary.js');
    const { processThumbnailJob } = await import('../src/lib/thumbnailProcessor.js');

    vi.mocked(fetchImageBuffer).mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      processThumbnailJob({
        listingId: new Types.ObjectId().toString(),
        publicId: 'listings/abc/whatever',
        url: 'https://example.com/whatever.jpg',
      }),
    ).rejects.toThrow('ECONNRESET');
  });
});
