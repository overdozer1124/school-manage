import { z } from "zod";
import { dateStringSchema, type SummaryResult } from "@school-manage/calendar-types";

/**
 * Payload shapes for the summary action (Issue #47). The input
 * is getRange's, read for the same view over the same period,
 * with the cookie a named field as in the range actions: the
 * platform reads (days, holidays, masters) are made with the
 * caller's own session, forwarded as-is.
 */
const nonEmptyString = z.string().min(1);

export const getSummaryInputSchema = z
  .object({
    from: dateStringSchema,
    to: dateStringSchema,
    viewId: nonEmptyString,
    cookie: nonEmptyString,
  })
  .refine((v) => v.from <= v.to, { message: "from must be on or before to" });
export type GetSummaryInput = z.infer<typeof getSummaryInputSchema>;

/** The summary of one view over one period: the derivation of
 *  calendar-types' summarizeRange, with the period it counted. */
export interface SummaryResponse extends SummaryResult {
  from: string;
  to: string;
  viewId: string;
}
