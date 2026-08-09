import { describe, expect, it } from 'vitest';
import { confirmSaleRequestSchema, RESERVATION_TTL_MS } from '../src/reservations.js';

describe('confirmSaleRequestSchema', () => {
  it('accepts a non-empty buyerId', () => {
    expect(
      confirmSaleRequestSchema.safeParse({ buyerId: '64b64b64b64b64b64b64b64b' }).success,
    ).toBe(true);
  });

  it('rejects an empty buyerId', () => {
    expect(confirmSaleRequestSchema.safeParse({ buyerId: '' }).success).toBe(false);
  });

  it('rejects a missing buyerId', () => {
    expect(confirmSaleRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('RESERVATION_TTL_MS', () => {
  it('is 30 minutes, per ARCHITECTURE.md §4', () => {
    expect(RESERVATION_TTL_MS).toBe(30 * 60 * 1000);
  });
});
