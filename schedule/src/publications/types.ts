import { z } from "zod";
import type { PublicationPrintSettings } from "../db/schema.js";

/**
 * Payload shapes for the publication actions (Issue #40). The
 * cookie is a named field, as in the other actions that read the
 * platform (Issue #29): publishing reads the month through
 * getRange, with the caller's own session forwarded as-is.
 */
const nonEmptyString = z.string().min(1);

export const printSettingsInputSchema = z.object({
  paper: z.enum(["A4", "A3"]).optional(),
  orientation: z.enum(["landscape", "portrait"]).optional(),
  marginMm: z.number().min(5).max(30).optional(),
  fontScale: z.enum(["small", "medium", "large"]).optional(),
});
export type PrintSettingsInput = z.infer<typeof printSettingsInputSchema>;

export const createPublicationInputSchema = z.object({
  viewId: nonEmptyString,
  /** The issued month, "YYYY-MM" (DESIGN schedule 4.8's
   *  target_month; Phase 1 issues month tables, §9.1). */
  targetMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "targetMonth must be YYYY-MM"),
  versionLabel: nonEmptyString,
  note: z.string().nullable().optional(),
  printSettings: printSettingsInputSchema.optional(),
  cookie: nonEmptyString,
});
export type CreatePublicationInput = z.infer<typeof createPublicationInputSchema>;

export const getPublicationsInputSchema = z.object({
  viewId: nonEmptyString.optional(),
});
export type GetPublicationsInput = z.infer<typeof getPublicationsInputSchema>;

export const getPublicationInputSchema = z.object({
  id: nonEmptyString,
});
export type GetPublicationInput = z.infer<typeof getPublicationInputSchema>;

/**
 * The defaults a month table is issued with when neither the
 * view nor the publisher says otherwise (DESIGN schedule 9.1:
 * 月表は A4横）.
 */
export const DEFAULT_PRINT_SETTINGS: PublicationPrintSettings = {
  paper: "A4",
  orientation: "landscape",
  marginMm: 10,
  fontScale: "medium",
};

/**
 * The settings one publication is generated with: the defaults,
 * then the view definition's own print_settings (DESIGN schedule
 * 9.1 keeps them on the view), then the publisher's choices at
 * publish time. The view's JSON is read field by field — it is
 * school-edited data, so a value of the wrong shape is ignored
 * rather than trusted.
 */
export function resolvePrintSettings(
  viewSettings: Record<string, unknown> | null,
  override?: PrintSettingsInput,
): PublicationPrintSettings {
  const resolved: PublicationPrintSettings = { ...DEFAULT_PRINT_SETTINGS };
  const fromView = printSettingsInputSchema.safeParse(viewSettings ?? {});
  if (fromView.success) Object.assign(resolved, fromView.data);
  if (override) Object.assign(resolved, override);
  return resolved;
}
