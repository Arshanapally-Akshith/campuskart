import {
  attachImageRequestSchema,
  attributesSchemaByCategory,
  confirmSaleRequestSchema,
  createListingSchema,
  createReportRequestSchema,
  ErrorCode,
  FEED_PAGE_SIZE,
  listFeedQuerySchema,
  MAX_IMAGES_PER_LISTING,
  removeImageRequestSchema,
  reorderImagesRequestSchema,
  REPORT_HIDE_THRESHOLD,
  SEARCH_MAX_PAGES,
  updateListingSchema,
  type FeedResponse,
  type Listing as ListingDto,
  type ListingDetailResponse,
  type ListingSummary,
  type ReportResponse,
} from '@campuskart/shared';
import { Router, type Router as RouterType } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../lib/asyncHandler.js';
import { destroyAsset } from '../lib/cloudinary.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { bumpFeedVersion, getCachedFeedPage, setCachedFeedPage } from '../lib/feedCache.js';
import { logger } from '../lib/logger.js';
import { isDuplicateKeyError } from '../lib/mongoErrors.js';
import {
  listingCreateRateLimiter,
  rateLimitMiddleware,
  reportRateLimiter,
} from '../lib/rateLimit.js';
import { cancelReservation, confirmSale, reserveListing } from '../lib/reservationService.js';
import { thumbnailQueue } from '../lib/thumbnailQueue.js';
import { AppError } from '../middleware/errorHandler.js';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { getAuthUser, requireAuth } from '../middleware/requireAuth.js';
import { Listing, type ListingDocument } from '../models/Listing.js';
import { Report } from '../models/Report.js';
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

// BUILD.md Phase 9: the shape `GET /api/listings` (browse and search) is
// queried and mapped to, once `.select('-description -attributes')` is
// applied — see the `ListingSummary` doc comment in packages/shared for the
// measurement that motivated it. `.lean()` alongside it means these are
// plain objects, not hydrated Mongoose documents (skips change-tracking/
// getter overhead across every row of every feed page) — `_id` is still a
// real ObjectId and date fields are still real Dates, so the field access
// below is unaffected either way.
interface LeanListingSummaryDoc {
  _id: Types.ObjectId;
  sellerId: Types.ObjectId;
  title: string;
  category: ListingDto['category'];
  priceInPaise: number;
  condition: ListingDto['condition'];
  images: {
    publicId: string;
    url: string;
    thumbUrl?: string | null;
    width: number;
    height: number;
  }[];
  status: ListingDto['status'];
  reservedBy?: Types.ObjectId | null;
  reservedAt?: Date | null;
  reservationExpiresAt?: Date | null;
  soldTo?: Types.ObjectId | null;
  soldAt?: Date | null;
  version: number;
  reportCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toListingSummary(doc: LeanListingSummaryDoc): ListingSummary {
  return {
    id: doc._id.toString(),
    sellerId: doc.sellerId.toString(),
    title: doc.title,
    category: doc.category,
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

    // ARCHITECTURE.md §9: reportCount >= threshold auto-hides from the
    // feed — not a status change, so a hidden listing is still ACTIVE,
    // still owner-editable, and still reachable by direct id (GET /:id).
    const baseFilter: Record<string, unknown> = {
      status: 'ACTIVE',
      reportCount: { $lt: REPORT_HIDE_THRESHOLD },
    };
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
      const docs = await Listing.find(searchFilter, {
        score: { $meta: 'textScore' },
        description: 0,
        attributes: 0,
      })
        .sort({ score: { $meta: 'textScore' } })
        .skip(skip)
        .limit(FEED_PAGE_SIZE + 1)
        .lean();

      const hasMore = docs.length > FEED_PAGE_SIZE && page < SEARCH_MAX_PAGES;
      const pageDocs = docs.slice(0, FEED_PAGE_SIZE);

      const body: FeedResponse = {
        listings: pageDocs.map(toListingSummary),
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
      .select('-description -attributes')
      .sort({ createdAt: -1, _id: -1 })
      .limit(FEED_PAGE_SIZE + 1)
      .lean();

    const hasMore = docs.length > FEED_PAGE_SIZE;
    const pageDocs = docs.slice(0, FEED_PAGE_SIZE);
    const last = pageDocs[pageDocs.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last._id.toString()) : null;

    const body: FeedResponse = {
      listings: pageDocs.map(toListingSummary),
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
  // BUILD.md Phase 7: listing creation 10/day/user.
  rateLimitMiddleware(listingCreateRateLimiter, (req) => getAuthUser(req).sub),
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
    if (!id) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'Missing listing id');
    }

    const reserved = await reserveListing(id, buyerId);
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
    if (!id) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'Missing listing id');
    }

    const cancelled = await cancelReservation(id, actorId);
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
    if (!id) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'Missing listing id');
    }
    const { buyerId } = confirmSaleRequestSchema.parse(req.body);

    const sold = await confirmSale(id, actorId, buyerId);

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

listingsRouter.post(
  '/:id/report',
  requireAuth,
  // BUILD.md Phase 7: reports 20/day/user.
  rateLimitMiddleware(reportRateLimiter, (req) => getAuthUser(req).sub),
  asyncHandler(async (req, res) => {
    const { sub: reporterId } = getAuthUser(req);
    const { id } = req.params;
    if (!id) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'Missing listing id');
    }
    const input = createReportRequestSchema.parse(req.body);

    const listing = await Listing.findById(id).select('_id');
    if (!listing) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Listing not found');
    }

    // Duplicate-report guard: the unique `{listingId, reporterId}` index on
    // Report is the actual guarantee; this catch just turns the loser of a
    // race (or a plain repeat report) into a 409 instead of a 500.
    let report;
    try {
      report = await Report.create({
        listingId: id,
        reporterId,
        reason: input.reason,
        note: input.note ?? null,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new AppError(409, ErrorCode.CONFLICT, 'You have already reported this listing');
      }
      throw err;
    }

    // Two documents (Report, Listing), so this isn't one atomic operation —
    // unlike the reservation state machine (ARCHITECTURE.md §4), nothing
    // here needs single-document atomicity: the unique index above is what
    // actually prevents double-counting, and a crash between these two
    // writes just leaves one report's count uncredited, not a corrupted
    // state. ARCHITECTURE.md deliberately avoids multi-document
    // transactions elsewhere for the same reason (standalone dev Mongo has
    // no replica set to run them on).
    const updated = await Listing.findByIdAndUpdate(
      id,
      { $inc: { reportCount: 1 } },
      { new: true },
    ).select('reportCount status');

    // Feed cache is keyed on filters, not reportCount, so any listing that
    // just crossed the auto-hide threshold needs an explicit invalidation —
    // the same reasoning as every other mutation that changes what the
    // ACTIVE-only feed shows.
    if (updated && updated.status === 'ACTIVE' && updated.reportCount >= REPORT_HIDE_THRESHOLD) {
      await bumpFeedVersion();
    }

    const body: ReportResponse = {
      id: report._id.toString(),
      listingId: id,
      reason: report.reason,
      note: report.note ?? null,
      createdAt: report.createdAt.toISOString(),
    };
    res.status(201).json(body);
  }),
);
