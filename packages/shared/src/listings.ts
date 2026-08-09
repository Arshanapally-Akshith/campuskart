import { z } from 'zod';

export const CATEGORIES = ['ELECTRONICS', 'BOOKS', 'CYCLE', 'FURNITURE', 'LAB', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const LISTING_STATUSES = ['DRAFT', 'ACTIVE', 'RESERVED', 'SOLD', 'REMOVED'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

// Category-specific attribute shapes. `.strict()` is what makes the
// discriminated union below actually validate "per category" — a CYCLE
// listing can't carry an ELECTRONICS field (or vice versa), and each
// category gets one attribute that genuinely defines it as required.
const electronicsAttributesSchema = z
  .object({
    brand: z.string().min(1).max(60),
    model: z.string().min(1).max(60).optional(),
    warrantyMonths: z.number().int().min(0).max(120).optional(),
  })
  .strict();

const booksAttributesSchema = z
  .object({
    author: z.string().min(1).max(100),
    edition: z.string().min(1).max(40).optional(),
    isbn: z.string().min(1).max(20).optional(),
  })
  .strict();

const cycleAttributesSchema = z
  .object({
    gearCount: z.number().int().min(0).max(30),
    brand: z.string().min(1).max(60).optional(),
    frameSize: z.string().min(1).max(20).optional(),
  })
  .strict();

const furnitureAttributesSchema = z
  .object({
    material: z.string().min(1).max(60),
    dimensions: z.string().min(1).max(60).optional(),
  })
  .strict();

const labAttributesSchema = z
  .object({
    equipmentType: z.string().min(1).max(60),
    brand: z.string().min(1).max(60).optional(),
  })
  .strict();

// OTHER is the deliberate catch-all with no defined shape.
const otherAttributesSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export const attributesSchemaByCategory = {
  ELECTRONICS: electronicsAttributesSchema,
  BOOKS: booksAttributesSchema,
  CYCLE: cycleAttributesSchema,
  FURNITURE: furnitureAttributesSchema,
  LAB: labAttributesSchema,
  OTHER: otherAttributesSchema,
} as const satisfies Record<Category, z.ZodType>;

const listingCoreFields = {
  title: z.string().trim().min(5).max(100),
  description: z.string().trim().min(20).max(2000),
  priceInPaise: z.number().int().positive().max(100_000_000),
  condition: z.enum(CONDITIONS),
};

// The free-text/enum fields on their own — used as the react-hook-form
// resolver for the base of the create/edit form, where `category` is
// tracked separately (outside RHF) to drive which attribute inputs render.
// `priceInPaise` is deliberately excluded too: the form displays and edits
// a *rupee* amount for the human, converting to integer paise only at
// submit time, so it can't share a resolver schema whose field is typed
// (and validated as `.int()`) in paise. react-hook-form's `Path<T>` typing
// also does not resolve cleanly over a discriminated union, so the full
// union is only used for the final, authoritative `.parse()` right before
// the request is sent.
export const listingTextFieldsSchema = z.object({
  title: listingCoreFields.title,
  description: listingCoreFields.description,
  condition: listingCoreFields.condition,
});
export type ListingTextFieldsInput = z.infer<typeof listingTextFieldsSchema>;

export const createListingSchema = z.discriminatedUnion('category', [
  z.object({
    category: z.literal('ELECTRONICS'),
    attributes: electronicsAttributesSchema,
    ...listingCoreFields,
  }),
  z.object({
    category: z.literal('BOOKS'),
    attributes: booksAttributesSchema,
    ...listingCoreFields,
  }),
  z.object({
    category: z.literal('CYCLE'),
    attributes: cycleAttributesSchema,
    ...listingCoreFields,
  }),
  z.object({
    category: z.literal('FURNITURE'),
    attributes: furnitureAttributesSchema,
    ...listingCoreFields,
  }),
  z.object({ category: z.literal('LAB'), attributes: labAttributesSchema, ...listingCoreFields }),
  z.object({
    category: z.literal('OTHER'),
    attributes: otherAttributesSchema,
    ...listingCoreFields,
  }),
]);

export type CreateListingInput = z.infer<typeof createListingSchema>;

// PATCH deliberately excludes `category`: attributes are validated against
// a category, so changing category and attributes together needs the full
// discriminated union — simpler and more honest to say "make a new listing"
// than to half-support reclassification. `status` is never in here; it's
// mutated only by dedicated guarded endpoints (publish, delete, and
// Phase 5's reserve/cancel/confirm-sale).
export const updateListingSchema = z
  .object({
    title: listingCoreFields.title,
    description: listingCoreFields.description,
    priceInPaise: listingCoreFields.priceInPaise,
    condition: listingCoreFields.condition,
    attributes: z.record(z.string(), z.union([z.string(), z.number()])),
  })
  .partial();

export type UpdateListingInput = z.infer<typeof updateListingSchema>;

export interface ListingImage {
  publicId: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
}

export interface Listing {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  category: Category;
  attributes: Record<string, string | number>;
  priceInPaise: number;
  condition: Condition;
  images: ListingImage[];
  status: ListingStatus;
  reservedBy: string | null;
  reservedAt: string | null;
  reservationExpiresAt: string | null;
  soldTo: string | null;
  soldAt: string | null;
  version: number;
  reportCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The one place a price becomes a rupee string. Everything else — storage,
 * API payloads, form state — stays integer paise. ₹1,299.50 stored as
 * 129950.
 */
export function formatPaise(priceInPaise: number): string {
  const rupees = priceInPaise / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
