import { createHash } from 'node:crypto';
import type { FeedResponse } from '@campuskart/shared';
import { redis } from './redis.js';

const FEED_CACHE_TTL_SECONDS = 60;
const VERSION_KEY = 'feed:version';

export interface FeedFilterKey {
  category?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  condition?: string | undefined;
  seller?: string | undefined;
}

const CANONICAL_FILTER_KEYS = ['category', 'condition', 'maxPrice', 'minPrice', 'seller'] as const;

function hashFilters(filters: FeedFilterKey): string {
  const canonical = CANONICAL_FILTER_KEYS.map((key) => `${key}=${String(filters[key] ?? '')}`).join(
    '&',
  );
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

async function getVersion(): Promise<string> {
  return (await redis.get(VERSION_KEY)) ?? '0';
}

/** ARCHITECTURE.md §6: "Invalidate by bumping v on any listing state
 * change" — called from the guarded status-transition endpoints
 * (publish, delete; Phase 5's reserve/cancel/confirm-sale will do the
 * same). Plain field edits (PATCH) rely on the 60s TTL alone, same as any
 * cache respects its own expiry. */
export async function bumpFeedVersion(): Promise<void> {
  await redis.incr(VERSION_KEY);
}

function cacheKey(version: string, filterHash: string, slot: 'p1' | 'p2'): string {
  return `feed:v${version}:${filterHash}:${slot}`;
}

/**
 * Only the first two pages of the browse feed are cacheable (ARCHITECTURE.md
 * §6). Page 1 is unambiguous (no cursor). A cursor-bearing request is only
 * ever treated as "page 2" if it matches the `nextCursor` that a currently
 * cached page 1 actually produced — anything else (a deeper page, or page 1
 * having already expired) is never cached, so we can't misidentify some
 * arbitrary deep page as page 2 and serve it back incorrectly.
 */
export async function getCachedFeedPage(
  filters: FeedFilterKey,
  cursor: string | null,
): Promise<FeedResponse | null> {
  const version = await getVersion();
  const filterHash = hashFilters(filters);

  const page1Raw = await redis.get(cacheKey(version, filterHash, 'p1'));
  if (cursor === null) {
    return page1Raw ? (JSON.parse(page1Raw) as FeedResponse) : null;
  }

  if (!page1Raw) return null;
  const page1 = JSON.parse(page1Raw) as FeedResponse;
  if (page1.nextCursor !== cursor) return null;

  const page2Raw = await redis.get(cacheKey(version, filterHash, 'p2'));
  return page2Raw ? (JSON.parse(page2Raw) as FeedResponse) : null;
}

export async function setCachedFeedPage(
  filters: FeedFilterKey,
  cursor: string | null,
  response: FeedResponse,
): Promise<void> {
  const version = await getVersion();
  const filterHash = hashFilters(filters);

  if (cursor === null) {
    await redis.set(
      cacheKey(version, filterHash, 'p1'),
      JSON.stringify(response),
      'EX',
      FEED_CACHE_TTL_SECONDS,
    );
    return;
  }

  const page1Raw = await redis.get(cacheKey(version, filterHash, 'p1'));
  if (!page1Raw) return;
  const page1 = JSON.parse(page1Raw) as FeedResponse;
  if (page1.nextCursor !== cursor) return;

  await redis.set(
    cacheKey(version, filterHash, 'p2'),
    JSON.stringify(response),
    'EX',
    FEED_CACHE_TTL_SECONDS,
  );
}
