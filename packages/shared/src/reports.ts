import { z } from 'zod';

/** ARCHITECTURE.md §9: "reportCount ≥ 3 auto-hides from feed." */
export const REPORT_HIDE_THRESHOLD = 3;

export const REPORT_REASONS = [
  'SPAM',
  'SCAM',
  'PROHIBITED_ITEM',
  'INAPPROPRIATE',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const createReportRequestSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(500).optional(),
});
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

export interface ReportResponse {
  id: string;
  listingId: string;
  reason: ReportReason;
  note: string | null;
  createdAt: string;
}
