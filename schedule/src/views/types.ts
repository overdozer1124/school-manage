import { z } from "zod";
import {
  audienceSchema,
  periodScopeSchema,
  viewColumnSourceKindSchema,
  viewLayoutSchema,
} from "@school-manage/calendar-types";

/**
 * Payload shapes for the view actions (Issue #32). The layout,
 * audience, period scope and source kind enums are the shared ones
 * from @school-manage/calendar-types (DESIGN schedule 4.8 / 4.8.1),
 * and the database holds the same lists as check constraints. The
 * layout list includes the Phase 2 layouts: a definition may name
 * one before any screen renders it.
 */
const nonEmptyString = z.string().min(1);

export const viewColumnInputSchema = z
  .object({
    id: nonEmptyString,
    sourceKind: viewColumnSourceKindSchema,
    itemDefinitionId: nonEmptyString.nullable().optional(),
    dutyDefinitionId: nonEmptyString.nullable().optional(),
    targetGroupId: nonEmptyString.nullable().optional(),
    groupSameValues: z.boolean().optional(),
    widthHint: z.number().int().nullable().optional(),
    sort: z.number().int().optional(),
  })
  .refine(
    (c) =>
      (c.sourceKind === "daily_item" && c.itemDefinitionId != null && c.dutyDefinitionId == null) ||
      (c.sourceKind === "duty" && c.dutyDefinitionId != null && c.itemDefinitionId == null) ||
      ((c.sourceKind === "event_category" || c.sourceKind === "day_attribute") &&
        c.itemDefinitionId == null &&
        c.dutyDefinitionId == null),
    {
      message:
        "a daily_item column names an item definition, a duty column names a duty definition, other columns name neither",
    },
  );
export type ViewColumnInput = z.infer<typeof viewColumnInputSchema>;

export const viewDefinitionInputSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  layout: viewLayoutSchema,
  layoutParams: z.record(z.string(), z.unknown()).nullable().optional(),
  audience: audienceSchema,
  periodScope: periodScopeSchema,
  printSettings: z.record(z.string(), z.unknown()).nullable().optional(),
  /** When given, replaces the view's columns wholesale (the same
   *  treatment as an item definition's options, Issue #27). */
  columns: z.array(viewColumnInputSchema).optional(),
});
export type ViewDefinitionInput = z.infer<typeof viewDefinitionInputSchema>;

export const updateColumnWidthInputSchema = z.object({
  viewId: nonEmptyString,
  columnId: nonEmptyString,
  widthHint: z.number().int().nullable(),
});
export type UpdateColumnWidthInput = z.infer<typeof updateColumnWidthInputSchema>;

export const deleteViewInputSchema = z.object({
  id: nonEmptyString,
});

export const setViewArchivedInputSchema = z.object({
  id: nonEmptyString,
  archived: z.boolean(),
});
export type SetViewArchivedInput = z.infer<typeof setViewArchivedInputSchema>;

/**
 * One goal of a month note (Issue #46): the text as written, or
 * null for "not set". An empty (or whitespace-only) string is
 * the form's way of clearing a goal, so it is read as null —
 * the stored note never carries an empty goal. The text is
 * capped at 100 characters: the goals head the printed sheet,
 * so they stay a headline, not a paragraph.
 */
const monthNoteGoalSchema = z
  .string()
  .max(100)
  .nullable()
  .transform((value) => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });

/** Writing one view's one month of accompanying notes (Issue
 *  #46): the month is YYYY-MM, and the two goals are the student
 *  table's 生活目標・健康目標 (DESIGN schedule 7). */
export const setViewMonthNoteInputSchema = z.object({
  viewId: nonEmptyString,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
  lifeGoal: monthNoteGoalSchema,
  healthGoal: monthNoteGoalSchema,
});
export type SetViewMonthNoteInput = z.infer<typeof setViewMonthNoteInputSchema>;
