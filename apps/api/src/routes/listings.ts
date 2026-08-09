import {
  attributesSchemaByCategory,
  createListingSchema,
  ErrorCode,
  updateListingSchema,
  type Listing as ListingDto,
} from '@campuskart/shared';
import { Router, type Router as RouterType } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { getAuthUser, requireAuth } from '../middleware/requireAuth.js';
import { Listing, type ListingDocument } from '../models/Listing.js';

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
    images: doc.images,
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

    res.status(200).json(toPublicListing(published));
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

    res.status(200).json(toPublicListing(listing));
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

    res.status(200).json(toPublicListing(removed));
  }),
);
