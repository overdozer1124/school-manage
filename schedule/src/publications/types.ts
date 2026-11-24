import { z } from "zod";
import { dateStringSchema } from "@school-manage/calendar-types";
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

export const createPublicationInputSchema = z
  .object({
    viewId: nonEmptyString,
    /** The issued month, "YYYY-MM" (DESIGN schedule 4.8's
     *  target_month; Phase 1 issues month tables, §9.1). Issue
     *  #49 keeps it as the month the issued span starts in. */
    targetMonth: targetMonthSchema,
    /** The issued span (Issue #49): the first and last days of
     *  the period the document covers — a week of a week table,
     *  the school year of a year table. Both or neither: omitted,
     *  the span is the target month, as it was before spans. */
    from: dateStringSchema.optional(),
    to: dateStringSchema.optional(),
    versionLabel: nonEmptyString,
    note: z.string().nullable().optional(),
    printSettings: printSettingsInputSchema.optional(),
    cookie: nonEmptyString,
  })
  .refine((v) => (v.from === undefined) === (v.to === undefined), {
    message: "from and to must be named together",
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: "from must be on or before to",
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
 * The print defaults of each layout (Issue #49; DESIGN
 * schedule 4.8.1, 9.1): the rows tables (L1 month, L2 week) and
 * the two-column student table are A4 landscape; the year table
 * (L3) is the wide paper it is drawn for, A3 landscape; the
 * month calendar (L4) is one A4 page, portrait. A layout not
 * listed keeps the month table's defaults.
 */
export const LAYOUT_PRINT_DEFAULTS: Record<string, Partial<PublicationPrintSettings>> = {
  year_columns: { paper: "A3", orientation: "landscape" },
  calendar_grid: { paper: "A4", orientation: "portrait" },
};

/**
 * The settings one publication is generated with: the layout's
 * defaults, then the view definition's own print_settings
 * (DESIGN schedule 9.1 keeps them on the view), then the
 * publisher's choices at publish time. The view's JSON is read
 * field by field — it is school-edited data, so a value of the
 * wrong shape is ignored rather than trusted.
 */
export function resolvePrintSettings(
  viewSettings: Record<string, unknown> | null,
  override?: PrintSettingsInput,
  layout?: string,
): PublicationPrintSettings {
  const resolved: PublicationPrintSettings = { ...DEFAULT_PRINT_SETTINGS };
  if (layout && LAYOUT_PRINT_DEFAULTS[layout]) {
    Object.assign(resolved, LAYOUT_PRINT_DEFAULTS[layout]);
  }
  const fromView = printSettingsInputSchema.safeParse(viewSettings ?? {});
  if (fromView.success) Object.assign(resolved, fromView.data);
  if (override) Object.assign(resolved, override);
  return resolved;
}
