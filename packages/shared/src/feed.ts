import { z } from 'zod';
import { CATEGORIES, CONDITIONS } from './listings.js';
import type { Listing } from './listings.js';

export const FEED_PAGE_SIZE = 20;

// ARCHITECTURE.md §6: MongoDB can't efficiently combine `$text` relevance
// sort with the compound index cursor pagination relies on, so search
// results are relevance-sorted with offset pagination, hard-capped here
// rather than the O(log n)-per-page cursor scheme the plain browse feed
// uses. Beyond this page the honest answer is Atlas Search/OpenSearch with
// searchAfter — not something this design tries to fake.
export const SEARCH_MAX_PAGES = 10;

export const listFeedQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().positive().optional(),
  condition: z.enum(CONDITIONS).optional(),
  seller: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  // Search mode only — offset pagination needs a page number; the browse
  // feed ignores this and uses `cursor` instead.
  page: z.coerce.number().int().min(1).max(SEARCH_MAX_PAGES).optional(),
});
export type ListFeedQuery = z.infer<typeof listFeedQuerySchema>;

export interface FeedResponse {
  listings: Listing[];
  hasMore: boolean;
  /** Browse mode only (cursor pagination); null in search mode. */
  nextCursor: string | null;
  /** Search mode only (offset pagination). */
  page?: number;
  totalPages?: number;
}
