import { describe, expect, it } from 'vitest';
import { isNitwEmail } from '../src/auth.js';

// ARCHITECTURE.md §8: "the domain check is the trust boundary that makes a
// campus marketplace work at all — it's product logic, not decoration."
describe('isNitwEmail', () => {
  it('accepts a well-formed @student.nitw.ac.in address', () => {
    expect(isNitwEmail('someone@student.nitw.ac.in')).toBe(true);
  });

  it('is case-insensitive on the domain', () => {
    expect(isNitwEmail('someone@STUDENT.NITW.AC.IN')).toBe(true);
  });

  it('rejects a look-alike domain', () => {
    expect(isNitwEmail('someone@student.nitw.ac.in.evil.com')).toBe(false);
  });

  it('rejects a non-NITW domain entirely', () => {
    expect(isNitwEmail('someone@gmail.com')).toBe(false);
  });

  it('rejects a staff-style nitw.ac.in address missing the student subdomain', () => {
    expect(isNitwEmail('someone@nitw.ac.in')).toBe(false);
  });

  it('rejects a string with no @ at all', () => {
    expect(isNitwEmail('not-an-email')).toBe(false);
  });

  it('rejects an address with embedded whitespace', () => {
    expect(isNitwEmail('some one@student.nitw.ac.in')).toBe(false);
  });
});
