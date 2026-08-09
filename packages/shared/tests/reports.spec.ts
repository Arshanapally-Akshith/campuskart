import { describe, expect, it } from 'vitest';
import {
  createReportRequestSchema,
  REPORT_HIDE_THRESHOLD,
  REPORT_REASONS,
} from '../src/reports.js';

describe('createReportRequestSchema', () => {
  it('accepts every declared reason with no note', () => {
    for (const reason of REPORT_REASONS) {
      expect(createReportRequestSchema.safeParse({ reason }).success).toBe(true);
    }
  });

  it('accepts a reason with an optional note', () => {
    const result = createReportRequestSchema.safeParse({ reason: 'SPAM', note: 'looks fake' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown reason', () => {
    expect(createReportRequestSchema.safeParse({ reason: 'I_JUST_DONT_LIKE_IT' }).success).toBe(
      false,
    );
  });

  it('rejects a missing reason', () => {
    expect(createReportRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a note over 500 characters', () => {
    const result = createReportRequestSchema.safeParse({
      reason: 'OTHER',
      note: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('trims the note', () => {
    const result = createReportRequestSchema.parse({ reason: 'OTHER', note: '  hi  ' });
    expect(result.note).toBe('hi');
  });
});

describe('REPORT_HIDE_THRESHOLD', () => {
  it('is 3, per ARCHITECTURE.md §9', () => {
    expect(REPORT_HIDE_THRESHOLD).toBe(3);
  });
});
