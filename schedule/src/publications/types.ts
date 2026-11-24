import { z } from "zod";
import type { PublicationPrintSettings } from "../db/schema.js";

/**
 * Payload shapes for the publication actions (Issue #40). The
 * cookie is a named field, as in the other actions that read the
 * platform (Issue #29): publishing reads the month through
 * getRange, with the caller's own session forwarded as-is.
 */
const nonEmptyString = z.string().min(1);

/** A "YYYY-MM" month, the publications' target_month shape. */
export const targetMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "targetMonth must be YYYY-MM");

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
  targetMonth: targetMonthSchema,
  versionLabel: nonEmptyString,
  note: z.string().nullable().optional(),
  printSettings: printSettingsInputSchema.optional(),
  cookie: nonEmptyString,
});
export type CreatePublicationInput = z.infer<typeof createPublicationInputSchema>;

export const getPublicationsInputSchema = z.object({
  viewId: nonEmptyString.optional(),
  /** Issue #48: the version list filters by month as well as
   *  by view. */
  targetMonth: targetMonthSchema.optional(),
});
export type GetPublicationsInput = z.infer<typeof getPublicationsInputSchema>;

export const getPublicationInputSchema = z.object({
  id: nonEmptyString,
});
export type GetPublicationInput = z.infer<typeof getPublicationInputSchema>;

/**
 * Correcting a version's label and/or note (Issue #48): at
 * least one of the two must be named — an update that changes
 * nothing is a mistake at the call site, not a no-op. The note
 * may be cleared by naming it null. The document and the
 * snapshot are never part of an update.
 */
export const updatePublicationInputSchema = z
  .object({
    id: nonEmptyString,
    versionLabel: nonEmptyString.optional(),
    note: z.string().nullable().optional(),
  })
  .refine((v) => v.versionLabel !== undefined || v.note !== undefined, {
    message: "versionLabel or note is required",
  });
export type UpdatePublicationInput = z.infer<typeof updatePublicationInputSchema>;

export const cancelPublicationInputSchema = z.object({
  id: nonEmptyString,
});
export type CancelPublicationInput = z.infer<typeof cancelPublicationInputSchema>;

export const getPublicationDiffInputSchema = z.object({
  id: nonEmptyString,
});
export type GetPublicationDiffInput = z.infer<typeof getPublicationDiffInputSchema>;

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
