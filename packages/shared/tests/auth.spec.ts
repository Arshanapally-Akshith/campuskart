import { describe, expect, it } from 'vitest';
import { isValidEmail } from '../src/auth.js';

describe('isValidEmail', () => {
  it('accepts a well-formed address', () => {
    expect(isValidEmail('someone@example.com')).toBe(true);
  });

  it('accepts a well-formed @student.nitw.ac.in address (no longer a required domain)', () => {
    expect(isValidEmail('someone@student.nitw.ac.in')).toBe(true);
  });

  it('rejects a string with no @ at all', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  it('rejects an address with no domain', () => {
    expect(isValidEmail('someone@')).toBe(false);
  });

  it('rejects an address with no TLD', () => {
    expect(isValidEmail('someone@localhost')).toBe(false);
  });

  it('rejects an address with embedded whitespace', () => {
    expect(isValidEmail('some one@example.com')).toBe(false);
  });
});
