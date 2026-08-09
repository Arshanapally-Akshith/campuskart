import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/lib/cursor.js';

// BUILD.md Phase 8 "Unit: cursor encode/decode". ARCHITECTURE.md §6: cursor
// = base64url(JSON.stringify({ c: createdAt.toISOString(), i: _id })).
describe('cursor encode/decode', () => {
  it('round-trips createdAt and id exactly', () => {
    const createdAt = new Date('2026-01-15T10:30:00.000Z');
    const id = '64b64b64b64b64b64b64b64b';

    const cursor = encodeCursor(createdAt, id);
    const decoded = decodeCursor(cursor);

    expect(decoded).toEqual({ c: createdAt.toISOString(), i: id });
  });

  it('produces a URL-safe token with no +, /, or = characters', () => {
    // Deliberately picked so the equivalent base64 (not base64url) encoding
    // would contain padding — this is the actual property that matters for
    // a value that travels in a query string.
    const cursor = encodeCursor(new Date('2026-01-01T00:00:00.000Z'), 'a');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null for a non-base64 garbage string', () => {
    expect(decodeCursor('not valid base64url !!! @@@')).toBeNull();
  });

  it('returns null for valid base64url that is not JSON', () => {
    const notJson = Buffer.from('this is plain text, not json').toString('base64url');
    expect(decodeCursor(notJson)).toBeNull();
  });

  it('returns null when the decoded JSON is missing the "c" or "i" field', () => {
    const missingI = Buffer.from(JSON.stringify({ c: 'x' })).toString('base64url');
    const missingC = Buffer.from(JSON.stringify({ i: 'x' })).toString('base64url');
    expect(decodeCursor(missingI)).toBeNull();
    expect(decodeCursor(missingC)).toBeNull();
  });

  it('returns null when "c" or "i" are the wrong type', () => {
    const wrongTypes = Buffer.from(JSON.stringify({ c: 12345, i: 67890 })).toString('base64url');
    expect(decodeCursor(wrongTypes)).toBeNull();
  });

  it('returns null for a JSON array or primitive instead of an object', () => {
    expect(decodeCursor(Buffer.from('[1,2,3]').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('"just a string"').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('null').toString('base64url'))).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });
});
