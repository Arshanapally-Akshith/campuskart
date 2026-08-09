import { describe, expect, it } from 'vitest';
import { listFeedQuerySchema, SEARCH_MAX_PAGES } from '../src/feed.js';

describe('listFeedQuerySchema', () => {
  it('accepts an empty query (browse mode, page 1, no filters)', () => {
    expect(listFeedQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces string query-param numbers into actual numbers', () => {
    const result = listFeedQuerySchema.parse({ minPrice: '100', maxPrice: '5000', page: '2' });
    expect(result.minPrice).toBe(100);
    expect(result.maxPrice).toBe(5000);
    expect(result.page).toBe(2);
  });

  it('rejects an unknown category', () => {
    expect(listFeedQuerySchema.safeParse({ category: 'VEHICLES' }).success).toBe(false);
  });

  it('rejects a negative minPrice', () => {
    expect(listFeedQuerySchema.safeParse({ minPrice: -1 }).success).toBe(false);
  });

  it('rejects a zero or negative maxPrice', () => {
    expect(listFeedQuerySchema.safeParse({ maxPrice: 0 }).success).toBe(false);
  });

  it(`caps page at SEARCH_MAX_PAGES (${String(SEARCH_MAX_PAGES)})`, () => {
    expect(listFeedQuerySchema.safeParse({ page: SEARCH_MAX_PAGES }).success).toBe(true);
    expect(listFeedQuerySchema.safeParse({ page: SEARCH_MAX_PAGES + 1 }).success).toBe(false);
  });

  it('rejects an empty search query string', () => {
    expect(listFeedQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('trims the search query string', () => {
    const result = listFeedQuerySchema.parse({ q: '  skateboard  ' });
    expect(result.q).toBe('skateboard');
  });
});
