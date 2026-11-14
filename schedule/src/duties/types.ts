import { z } from "zod";
import {
  dateStringSchema,
  dutyApplicablePeriodSchema,
  dutyGranularitySchema,
  weekdaySchema,
} from "@school-manage/calendar-types";

/**
 * Payload shapes for the duty actions (Issue #30). The granularity
 * and applicable-period enums are the shared ones from
 * @school-manage/calendar-types (DESIGN schedule 4.7); the database
 * holds the same lists as check constraints. Dates are the shared
 * YYYY-MM-DD schema, so a malformed date is refused before any
 * logic runs.
 */
const nonEmptyString = z.string().min(1);

export const rotationRuleInputSchema = z.object({
  /** The roster, in rotation order: platform staff-master ids. */
  personIds: z.array(nonEmptyString),
  /** Weekdays the holder changes on; null advances at every cell. */
  changeWeekdays: z.array(weekdaySchema).nullable().optional(),
});
export type RotationRuleInput = z.infer<typeof rotationRuleInputSchema>;

export const dutyDefinitionInputSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    granularity: dutyGranularitySchema,
    applicablePeriod: dutyApplicablePeriodSchema,
    /** The custom_range bounds; ignored by the other period kinds. */
    applicableStartsOn: dateStringSchema.nullable().optional(),
    applicableEndsOn: dateStringSchema.nullable().optional(),
    /** The axis of a students' duty; null is a staff duty. */
    targetGroupId: nonEmptyString.nullable().optional(),
    sort: z.number().int().optional(),
    /** When given, replaces the definition's rotation rule
     *  wholesale; null clears it (no automatic generation). */
    rotation: rotationRuleInputSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      !v.applicableStartsOn || !v.applicableEndsOn || v.applicableStartsOn <= v.applicableEndsOn,
    { message: "applicableStartsOn must not be after applicableEndsOn" },
  );
export type DutyDefinitionInput = z.infer<typeof dutyDefinitionInputSchema>;

export const deleteDutyInputSchema = z.object({
  id: nonEmptyString,
});

const rangeFields = {
  dutyDefinitionId: nonEmptyString,
  from: dateStringSchema,
  to: dateStringSchema,
};

const rangeRefine = (v: { from: string; to: string }) => v.from <= v.to;

export const getDutyAssignmentsInputSchema = z
  .object({
    ...rangeFields,
    dutyDefinitionId: nonEmptyString.optional(),
  })
  .refine(rangeRefine, { message: "from must not be after to" });
export type GetDutyAssignmentsInput = z.infer<typeof getDutyAssignmentsInputSchema>;

/**
 * A manual assignment. personId and targetId name the holder (a
 * staff member, or a target of the duty's axis); both null clears
 * the cell instead — the way to undo a manual set, since there is
 * no separate delete action in 4.4's list.
 */
export const setDutyAssignmentInputSchema = z.object({
  dutyDefinitionId: nonEmptyString,
  date: dateStringSchema,
  slot: nonEmptyString,
  personId: nonEmptyString.nullable().optional(),
  targetId: nonEmptyString.nullable().optional(),
  note: z.string().nullable().optional(),
});
export type SetDutyAssignmentInput = z.infer<typeof setDutyAssignmentInputSchema>;

/**
 * A rotation preview / apply over a range. slots names the period
 * numbers for a period-granularity duty (its fixed slot list is
 * empty: the periods belong to the day pattern); the other
 * granularities derive their slots and ignore this.
 */
export const rotationRangeInputSchema = z
  .object({
    ...rangeFields,
    slots: z.array(nonEmptyString).optional(),
  })
  .refine(rangeRefine, { message: "from must not be after to" });
export type RotationRangeInput = z.infer<typeof rotationRangeInputSchema>;
