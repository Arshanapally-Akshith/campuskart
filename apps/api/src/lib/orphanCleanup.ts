import { destroyAssets, listResourcesByPrefix, type CloudinaryResource } from './cloudinary.js';
import { logger } from './logger.js';
import { Listing } from '../models/Listing.js';

// BUILD.md Phase 3, "Watch": a user who abandons a draft mid-upload leaves
// a Cloudinary asset with no listing ever referencing it. Don't touch
// anything younger than this — the attach call (POST /listings/:id/images)
// may simply not have landed yet.
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Pure diff, no I/O: given a page of Cloudinary assets and the full set of
 * publicIds actually referenced by some listing, returns the ones old
 * enough and unreferenced enough to be safely deleted. Kept separate from
 * the Cloudinary/Mongo calls so it's unit-testable with plain data.
 */
export function findOrphanedAssets(
  assets: CloudinaryResource[],
  referencedPublicIds: ReadonlySet<string>,
  now: Date,
  minAgeMs = ORPHAN_MIN_AGE_MS,
): CloudinaryResource[] {
  return assets.filter((asset) => {
    if (asset.publicId.endsWith('_thumb')) return false; // owned by its original; that check covers it
    if (referencedPublicIds.has(asset.publicId)) return false;
    const ageMs = now.getTime() - new Date(asset.createdAt).getTime();
    return ageMs >= minAgeMs;
  });
}

async function getReferencedPublicIds(): Promise<Set<string>> {
  const listings = await Listing.find({}, { 'images.publicId': 1, _id: 0 }).lean();
  const ids = new Set<string>();
  for (const listing of listings) {
    for (const image of listing.images) {
      ids.add(image.publicId);
    }
  }
  return ids;
}

export interface OrphanCleanupResult {
  scanned: number;
  deleted: number;
}

export async function runOrphanCleanup(): Promise<OrphanCleanupResult> {
  const referenced = await getReferencedPublicIds();
  let scanned = 0;
  let deleted = 0;
  let cursor: string | null = null;

  do {
    const page = await listResourcesByPrefix('listings/', cursor);
    scanned += page.resources.length;

    const orphans = findOrphanedAssets(page.resources, referenced, new Date());
    if (orphans.length > 0) {
      await destroyAssets(orphans.map((o) => o.publicId));
      deleted += orphans.length;
      logger.info(
        { count: orphans.length, publicIds: orphans.map((o) => o.publicId) },
        'Deleted orphaned Cloudinary assets',
      );
    }

    cursor = page.nextCursor;
  } while (cursor);

  logger.info({ scanned, deleted }, 'Orphan cleanup run complete');
  return { scanned, deleted };
}
