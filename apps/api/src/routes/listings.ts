import {
  attachImageRequestSchema,
  attributesSchemaByCategory,
  confirmSaleRequestSchema,
  createListingSchema,
  ErrorCode,
  FEED_PAGE_SIZE,
  listFeedQuerySchema,
  MAX_IMAGES_PER_LISTING,
  removeImageRequestSchema,
  reorderImagesRequestSchema,
  RESERVATION_TTL_MS,
  SEARCH_MAX_PAGES,
  updateListingSchema,
  type FeedResponse,
  type Listing as ListingDto,
  type ListingDetailResponse,
} from '@campuskart/shared';
import { Router, type Router as RouterType } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../lib/asyncHandler.js';
import { destroyAsset } from '../lib/cloudinary.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { bumpFeedVersion, getCachedFeedPage, setCachedFeedPage } from '../lib/feedCache.js';
import { logger } from '../lib/logger.js';
import { thumbnailQueue } from '../lib/thumbnailQueue.js';
import { AppError } from '../middleware/errorHandler.js';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { getAuthUser, requireAuth } from '../middleware/requireAuth.js';
import { Listing, type ListingDocument } from '../models/Listing.js';
import { User } from '../models/User.js';

export const listingsRouter: RouterType = Router();

function toPublicListing(doc: ListingDocument): ListingDto {
  return {
    id: doc._id.toString(),
    sellerId: doc.sellerId.toString(),
    title: doc.title,
    description: doc.description,
    category: doc.category,
    attributes: doc.attributes as Record<string, string | number>,
    priceInPaise: doc.priceInPaise,
    condition: doc.condition,
    images: doc.images.map((img) => ({
      publicId: img.publicId,
      url: img.url,
      thumbUrl: img.thumbUrl ?? null,
      width: img.width,
      height: img.height,
    })),
    status: doc.status,
    reservedBy: doc.reservedBy ? doc.reservedBy.toString() : null,
    reservedAt: doc.reservedAt ? doc.reservedAt.toISOString() : null,
    reservationExpiresAt: doc.reservationExpiresAt ? doc.reservationExpiresAt.toISOString() : null,
    soldTo: doc.soldTo ? doc.soldTo.toString() : null,
    soldAt: doc.soldAt ? doc.soldAt.toISOString() : null,
    version: doc.version,
    reportCount: doc.reportCount,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function isOwner(doc: ListingDocument, actorId: string): boolean {
  return doc.sellerId.toString() === actorId;
}

/** ARCHITECTURE.md §9 "Phone privacy": revealed to the seller (their own
 * number) and to the buyer of a currently-active, unexpired reservation —
 * nobody else. */
function sellerPhoneVisibleTo(doc: ListingDocument, viewerId: string): boolean {
  if (isOwner(doc, viewerId)) return true;
  return (
    doc.status === 'RESERVED' &&
    doc.reservedBy?.toString() === viewerId &&
    doc.reservationExpiresAt !== null &&
    doc.reservationExpiresAt !== undefined &&
    doc.reservationExpiresAt.getTime() > Date.now()
  );
}

listingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listFeedQuerySchema.parse(req.query);

    const baseFilter: Record<string, unknown> = { status: 'ACTIVE' };
    if (query.category) baseFilter['category'] = query.category;
    if (query.condition) baseFilter['condition'] = query.condition;
    if (query.seller) baseFilter['sellerId'] = query.seller;
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const priceFilter: Record<string, number> = {};
      if (query.minPrice !== undefined) priceFilter['$gte'] = query.minPrice;
      if (query.maxPrice !== undefined) priceFilter['$lte'] = query.maxPrice;
      baseFilter['priceInPaise'] = priceFilter;
    }

    if (query.q) {
      // Search mode: relevance sort, offset pagination, hard-capped at
      // SEARCH_MAX_PAGES — see ARCHITECTURE.md §6 for why this can't share
      // the cursor-pagination compound index the plain browse feed uses.
      const page = query.page ?? 1;
      const skip = (page - 1) * FEED_PAGE_SIZE;

      const searchFilter = { ...baseFilter, $text: { $search: query.q } };
      const docs = await Listing.find(searchFilter, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .skip(skip)
        .limit(FEED_PAGE_SIZE + 1);

      const hasMore = docs.length > FEED_PAGE_SIZE && page < SEARCH_MAX_PAGES;
      const pageDocs = docs.slice(0, FEED_PAGE_SIZE);

      const body: FeedResponse = {
        listings: pageDocs.map(toPublicListing),
        hasMore,
        nextCursor: null,
        page,
        totalPages: SEARCH_MAX_PAGES,
      };
      res.status(200).json(body);
      return;
    }

    // Browse mode: cursor pagination — cacheable, unlike search.
    const cursorParam = query.cursor ?? null;
    const cacheFilters = {
      category: query.category,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      condition: query.condition,
      seller: query.seller,
    };

    const cached = await getCachedFeedPage(cacheFilters, cursorParam);
    if (cached) {
      res.status(200).json(cached);
      return;
    }

    const mongoFilter: Record<string, unknown> = { ...baseFilter };
    if (cursorParam) {
      const decoded = decodeCursor(cursorParam);
      if (!decoded || !Types.ObjectId.isValid(decoded.i)) {
        throw new AppError(400, ErrorCode.BAD_REQUEST, 'Invalid cursor');
      }
      // Watch (BUILD.md Phase 4): this must be a real Date, not the raw ISO
      // string, or Mongo compares BSON dates against a string and silently
      // returns wrong results instead of erroring.
      const createdAtDate = new Date(decoded.c);
      mongoFilter['$or'] = [
        { createdAt: { $lt: createdAtDate } },
        { createdAt: createdAtDate, _id: { $lt: new Types.ObjectId(decoded.i) } },
      ];
    }

    const docs = await Listing.find(mongoFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(FEED_PAGE_SIZE + 1);

    const hasMore = docs.length > FEED_PAGE_SIZE;
    const pageDocs = docs.slice(0, FEED_PAGE_SIZE);
    const last = pageDocs[pageDocs.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last._id.toString()) : null;

    const body: FeedResponse = {
      listings: pageDocs.map(toPublicListing),
      hasMore,
      nextCursor,
    };

    await setCachedFeedPage(cacheFilters, cursorParam, body);
    res.status(200).json(body);
  }),
);

listingsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: sellerId } = getAuthUser(req);
    const input = createListingSchema.parse(req.body);

    const listing = await Listing.create({
      sellerId,
      title: input.title,
      description: input.description,
      category: input.category,
      attributes: input.attributes,
      priceInPaise: input.priceInPaise,
      condition: input.condition,
      status: 'DRAFT',
    });

    res.status(201).json(toPublicListing(listing));
  }),
);

listingsRouter.post(
  '/:id/publish',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }

    // Guarded transition, not `doc.status = x; doc.save()` — ownership was
    // just confirmed above as a fast-path, but the filter below carries the
    // full guard (owner + expected state) so the write itself is safe even
    // under a concurrent request.
    const published = await Listing.findOneAndUpdate(
      { _id: id, sellerId: actorId, status: 'DRAFT' },
      { $set: { status: 'ACTIVE' }, $inc: { version: 1 } },
      { new: true },
    );
    if (!published) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Listing is not in DRAFT status');
    }
    await bumpFeedVersion(); // newly ACTIVE — the feed cache must stop serving stale pages

    res.status(200).json(toPublicListing(published));
  }),
);

listingsRouter.post(
  '/:id/reserve',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: buyerId } = getAuthUser(req);
    const { id } = req.params;

    // Fast-path 404 only — existence, not status. The guard that actually
    // decides who wins a race lives entirely in the atomic update below
    // (BUILD.md Phase 5, "Watch": a convenience check is not authorisation).
    const existing = await Listing.findById(id).select('_id');
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    const now = new Date();
    // ARCHITECTURE.md §4: single atomic conditional update. The filter and
    // the write happen as one document-level operation — no window between
    // "check" and "set" for a second request to slip through. The `$or`
    // clause is lazy expiry: a stale RESERVED reservation is as good as
    // ACTIVE, so an expired reservation is claimable without the sweeper
    // ever having to run.
    const reserved = await Listing.findOneAndUpdate(
      {
        _id: id,
        sellerId: { $ne: buyerId },
        $or: [{ status: 'ACTIVE' }, { status: 'RESERVED', reservationExpiresAt: { $lt: now } }],
      },
      {
        $set: {
          status: 'RESERVED',
          reservedBy: buyerId,
          reservedAt: now,
          reservationExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!reserved) {
      throw new AppError(
        409,
        ErrorCode.LISTING_UNAVAILABLE,
        'This listing is no longer available to reserve',
      );
    }
    await bumpFeedVersion(); // now RESERVED — must disappear from the ACTIVE-only feed

    res.status(200).json(toPublicListing(reserved));
  }),
);

listingsRouter.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    // Fast-path 403 for a clear non-party; the atomic filter below still
    // carries the full buyer-or-seller check as the actual authorisation.
    const isParty = isOwner(existing, actorId) || existing.reservedBy?.toString() === actorId;
    if (!isParty) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You are not a party to this reservation');
    }

    // Either party may cancel — the guard is the full authorisation check,
    // not just a fast path: it requires RESERVED *and* the actor to be the
    // buyer or the seller, all in one atomic filter.
    const cancelled = await Listing.findOneAndUpdate(
      {
        _id: id,
        status: 'RESERVED',
        $or: [{ reservedBy: actorId }, { sellerId: actorId }],
      },
      {
        $set: {
          status: 'ACTIVE',
          reservedBy: null,
          reservedAt: null,
          reservationExpiresAt: null,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!cancelled) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'Listing is not reserved, or you are not a party to the reservation',
      );
    }
    await bumpFeedVersion(); // back to ACTIVE — reappears in the feed

    res.status(200).json(toPublicListing(cancelled));
  }),
);

listingsRouter.post(
  '/:id/confirm-sale',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;
    const { buyerId } = confirmSaleRequestSchema.parse(req.body);

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Only the seller can confirm a sale');
    }

    const now = new Date();
    // ARCHITECTURE.md §4 confirm-sale guard: seller only, and the
    // reservation must still be held by the exact buyer named in the
    // request and not yet expired — an unexpired-at-request-time buyer who
    // let the clock run out while the seller was clicking "confirm" cannot
    // be sold to.
    const sold = await Listing.findOneAndUpdate(
      {
        _id: id,
        status: 'RESERVED',
        sellerId: actorId,
        reservedBy: buyerId,
        reservationExpiresAt: { $gt: now },
      },
      {
        $set: {
          status: 'SOLD',
          soldTo: buyerId,
          soldAt: now,
          reservedBy: null,
          reservedAt: null,
          reservationExpiresAt: null,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!sold) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'Listing is not in a reserved-by-this-buyer, unexpired state',
      );
    }

    res.status(200).json(toPublicListing(sold));
  }),
);

listingsRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const listing = await Listing.findById(id);
    if (!listing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    const isVisibleToEveryone = listing.status !== 'DRAFT' && listing.status !== 'REMOVED';
    const viewerIsOwner = req.user !== undefined && isOwner(listing, req.user.sub);
    if (!isVisibleToEveryone && !viewerIsOwner) {
      // 404, not 403: a draft's existence is not disclosed to non-owners.
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    let sellerPhone: string | null = null;
    if (req.user !== undefined && sellerPhoneVisibleTo(listing, req.user.sub)) {
      const seller = await User.findById(listing.sellerId).select('phone');
      sellerPhone = seller?.phone ?? null;
    }

    const body: ListingDetailResponse = { ...toPublicListing(listing), sellerPhone };
    res.status(200).json(body);
  }),
);

listingsRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }

    // `status` is intentionally not part of updateListingSchema — state
    // transitions only happen through dedicated guarded endpoints
    // (publish, delete, and Phase 5's reserve/cancel/confirm-sale). If this
    // handler could set status, the whole state machine would be
    // decorative (BUILD.md Phase 2, "Watch").
    const input = updateListingSchema.parse(req.body);

    const set: Record<string, unknown> = {};
    if (input.title !== undefined) set['title'] = input.title;
    if (input.description !== undefined) set['description'] = input.description;
    if (input.priceInPaise !== undefined) set['priceInPaise'] = input.priceInPaise;
    if (input.condition !== undefined) set['condition'] = input.condition;
    if (input.attributes !== undefined) {
      set['attributes'] = attributesSchemaByCategory[existing.category].parse(input.attributes);
    }

    if (Object.keys(set).length === 0) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'No updatable fields provided');
    }

    const updated = await Listing.findOneAndUpdate(
      { _id: id, sellerId: actorId },
      { $set: set },
      { new: true, runValidators: true },
    );
    if (!updated) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    res.status(200).json(toPublicListing(updated));
  }),
);

listingsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }

    const removed = await Listing.findOneAndUpdate(
      { _id: id, sellerId: actorId, status: { $ne: 'REMOVED' } },
      { $set: { status: 'REMOVED' }, $inc: { version: 1 } },
      { new: true },
    );
    if (!removed) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Listing already removed');
    }
    if (existing.status === 'ACTIVE') {
      await bumpFeedVersion(); // was visible in the feed; must disappear immediately
    }

    res.status(200).json(toPublicListing(removed));
  }),
);

listingsRouter.post(
  '/:id/images',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;
    if (!id) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'Missing listing id');
    }
    const input = attachImageRequestSchema.parse(req.body);

    if (!input.publicId.startsWith(`listings/${id}/`)) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'publicId was not issued for this listing');
    }

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }

    // Atomic cap enforcement: the array-size check lives in the filter
    // itself, so two concurrent attach requests can't both pass a stale
    // read and jointly exceed MAX_IMAGES_PER_LISTING.
    const updated = await Listing.findOneAndUpdate(
      {
        _id: id,
        sellerId: actorId,
        $expr: { $lt: [{ $size: '$images' }, MAX_IMAGES_PER_LISTING] },
      },
      {
        $push: {
          images: {
            publicId: input.publicId,
            url: input.url,
            thumbUrl: null,
            width: input.width,
            height: input.height,
          },
        },
      },
      { new: true },
    );
    if (!updated) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        `A listing may have at most ${String(MAX_IMAGES_PER_LISTING)} images`,
      );
    }

    await thumbnailQueue.add('generate-thumbnail', {
      listingId: id,
      publicId: input.publicId,
      url: input.url,
    });

    res.status(202).json(toPublicListing(updated));
  }),
);

listingsRouter.delete(
  '/:id/images',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;
    const { publicId } = removeImageRequestSchema.parse(req.body);

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }

    const updated = await Listing.findOneAndUpdate(
      { _id: id, sellerId: actorId },
      { $pull: { images: { publicId } } },
      { new: true },
    );
    if (!updated) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    // Best-effort: the DB is the source of truth for what the listing
    // shows, so a failed Cloudinary cleanup here is just wasted storage,
    // not a correctness bug — the weekly orphan-cleanup job catches it too.
    await destroyAsset(publicId).catch((err: unknown) => {
      logger.warn({ err, publicId }, 'Failed to delete image asset on Cloudinary');
    });
    await destroyAsset(`${publicId}_thumb`).catch(() => {
      // Thumbnail may not exist yet (still processing, or the original was
      // rejected before one was ever generated) — nothing to clean up then.
    });

    res.status(200).json(toPublicListing(updated));
  }),
);

listingsRouter.patch(
  '/:id/images/reorder',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sub: actorId } = getAuthUser(req);
    const { id } = req.params;
    const { publicIds } = reorderImagesRequestSchema.parse(req.body);

    const existing = await Listing.findById(id);
    if (!existing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }
    if (!isOwner(existing, actorId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not own this listing');
    }

    const currentIds = existing.images.map((img) => img.publicId);
    const isSamePermutation =
      publicIds.length === currentIds.length &&
      new Set(publicIds).size === currentIds.length &&
      publicIds.every((pid) => currentIds.includes(pid));
    if (!isSamePermutation) {
      throw new AppError(
        400,
        ErrorCode.BAD_REQUEST,
        "publicIds must be a reordering of the listing's current images",
      );
    }

    const imageByPublicId = new Map(existing.images.map((img) => [img.publicId, img]));
    const reordered = publicIds
      .map((pid) => imageByPublicId.get(pid))
      .filter((img): img is NonNullable<typeof img> => img !== undefined);

    const updated = await Listing.findOneAndUpdate(
      { _id: id, sellerId: actorId },
      { $set: { images: reordered } },
      { new: true },
    );
    if (!updated) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    res.status(200).json(toPublicListing(updated));
  }),
);
