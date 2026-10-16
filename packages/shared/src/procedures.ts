import { z } from 'zod';

export const PROCEDURE_CATEGORIES = ['fire', 'prealarm', 'fault', 'supervisory', 'disabled', 'test', 'comm'] as const;
export type ProcedureCategory = (typeof PROCEDURE_CATEGORIES)[number];

export const PROCEDURE_CATEGORY_LABELS_HE: Record<ProcedureCategory, string> = {
  fire: 'אש',
  prealarm: 'קדם-אזעקה',
  fault: 'תקלה',
  supervisory: 'פיקוח',
  disabled: 'מנוטרל',
  test: 'בדיקה',
  comm: 'תקלת תקשורת',
};

export const procedureInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(PROCEDURE_CATEGORIES),
  buildingId: z.uuid().nullable().default(null),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  active: z.boolean().default(true),
});
export type ProcedureInput = z.infer<typeof procedureInputSchema>;

export const procedureStepSchema = z.object({ done: z.boolean() });

export interface ProcedureView {
  id: string;
  name: string;
  category: ProcedureCategory;
  buildingId: string | null;
  buildingName: string | null;
  steps: string[];
  version: number;
  active: boolean;
  updatedAt: string;
}

export interface ProcedureRunView {
  procedureName: string;
  version: number;
  steps: { text: string; done: boolean; by: string | null; at: string | null }[];
  startedAt: string;
  completedAt: string | null;
}

export interface AlarmProcedureView {
  /** Applicable procedure template when no run exists yet. */
  template: { id: string; name: string; version: number; steps: string[] } | null;
  run: ProcedureRunView | null;
}

const isoDate = z.iso.date();

export const reportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    buildingId: z.uuid().optional(),
    category: z.enum(['fire', 'prealarm', 'fault', 'supervisory', 'disabled', 'test']).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must be before to' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 400, { message: 'range is limited to 400 days' });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface AlarmReportRow {
  id: string;
  raisedAt: string;
  clearedAt: string | null;
  ackedAt: string | null;
  ackSeconds: number | null;
  category: string;
  kind: string;
  buildingName: string | null;
  pointLabel: string | null;
  location: string | null;
  ackedBy: string | null;
}

export interface AlarmReport {
  total: number;
  byCategory: { category: string; count: number }[];
  byBuilding: { buildingName: string | null; count: number }[];
  responseTimes: { category: string; count: number; acked: number; unacked: number; medianSeconds: number | null; avgSeconds: number | null; maxSeconds: number | null }[];
  items: AlarmReportRow[];
}

export interface OpenIssueRow {
  pointId: string;
  category: string;
  buildingName: string | null;
  pointLabel: string;
  location: string | null;
  since: string | null;
}
