import { describe, expect, it } from 'vitest';
import {
  attributesSchemaByCategory,
  createListingSchema,
  formatPaise,
  updateListingSchema,
} from '../src/listings.js';

// BUILD.md Phase 8 "Unit: ... price formatting".
describe('formatPaise', () => {
  it('formats whole rupees with two decimal places and the rupee sign', () => {
    expect(formatPaise(150000)).toBe('₹1,500.00');
  });

  it('formats paise into the correct fractional rupees', () => {
    expect(formatPaise(129950)).toBe('₹1,299.50');
  });

  it('formats zero', () => {
    expect(formatPaise(0)).toBe('₹0.00');
  });

  it('applies Indian-style thousands separators for large amounts', () => {
    // 12,34,567.89 in the Indian numbering system, not 1,234,567.89.
    expect(formatPaise(123456789)).toBe('₹12,34,567.89');
  });

  it('never produces a floating-point rounding artefact for a value like 10.10', () => {
    expect(formatPaise(1010)).toBe('₹10.10');
  });
});

// BUILD.md Phase 8 "Unit: Zod schemas" — the discriminated union is the one
// piece of validation logic in this codebase complex enough to be worth
// testing in isolation from any HTTP layer (ARCHITECTURE.md §1: "shared Zod
// schemas between client/server kill a whole class of bugs").
describe('createListingSchema (discriminated union on category)', () => {
  const base = {
    title: 'A perfectly good title',
    description: 'A description that is definitely at least twenty characters long.',
    priceInPaise: 100000,
    condition: 'GOOD' as const,
  };

  it('accepts a valid listing for every category with its own required attribute', () => {
    const perCategory = [
      { category: 'ELECTRONICS' as const, attributes: { brand: 'Sony' } },
      { category: 'BOOKS' as const, attributes: { author: 'Some Author' } },
      { category: 'CYCLE' as const, attributes: { gearCount: 21 } },
      { category: 'FURNITURE' as const, attributes: { material: 'wood' } },
      { category: 'LAB' as const, attributes: { equipmentType: 'multimeter' } },
      { category: 'OTHER' as const, attributes: { anything: 'goes' } },
    ];
    for (const { category, attributes } of perCategory) {
      const result = createListingSchema.safeParse({ ...base, category, attributes });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a CYCLE listing carrying an ELECTRONICS-only attribute instead of gearCount', () => {
    const result = createListingSchema.safeParse({
      ...base,
      category: 'CYCLE',
      attributes: { brand: 'Trek' }, // missing required gearCount
    });
    expect(result.success).toBe(false);
  });

  it('rejects attributes that are valid for a different category (cross-category leakage)', () => {
    const result = createListingSchema.safeParse({
      ...base,
      category: 'ELECTRONICS',
      attributes: { gearCount: 21 }, // a CYCLE field, not ELECTRONICS
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown category value', () => {
    const result = createListingSchema.safeParse({
      ...base,
      category: 'VEHICLES',
      attributes: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a title shorter than the minimum length', () => {
    const result = createListingSchema.safeParse({
      ...base,
      title: 'Hi',
      category: 'OTHER',
      attributes: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer price', () => {
    const result = createListingSchema.safeParse({
      ...base,
      priceInPaise: 1500.5,
      category: 'OTHER',
      attributes: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive price', () => {
    const result = createListingSchema.safeParse({
      ...base,
      priceInPaise: 0,
      category: 'OTHER',
      attributes: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('attributesSchemaByCategory', () => {
  it('.strict() rejects an unknown extra field for a fixed-shape category', () => {
    const result = attributesSchemaByCategory.CYCLE.safeParse({
      gearCount: 21,
      thisFieldDoesNotExist: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('OTHER accepts an arbitrary string/number record', () => {
    const result = attributesSchemaByCategory.OTHER.safeParse({ anything: 'goes', count: 5 });
    expect(result.success).toBe(true);
  });
});

describe('updateListingSchema', () => {
  it('accepts a partial update with just one field', () => {
    const result = updateListingSchema.safeParse({ title: 'Updated title, long enough' });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (the route layer, not this schema, rejects an empty patch)', () => {
    expect(updateListingSchema.safeParse({}).success).toBe(true);
  });

  it("does not include a `status` field at all — it is not part of this schema's shape", () => {
    expect('status' in updateListingSchema.shape).toBe(false);
  });
});
