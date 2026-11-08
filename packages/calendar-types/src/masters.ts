import { z } from "zod";
import { dayScheduleKindSchema, nonEmptyString } from "./codes.js";
import { periodTimeSchema } from "./time.js";

/** Shared masters (2.4). App-specific leftovers (a timetable's subjects,
 *  a schedule's duty roster) stay in each app; these are the shared core. */

const masterBase = { schoolId: nonEmptyString, id: nonEmptyString };

/** 教職員. personId links to the platform person (login user), if any. */
export const staffMemberSchema = z.object({
  ...masterBase,
  name: nonEmptyString,
  shortName: nonEmptyString,
  sortOrder: z.number().int(),
  personId: nonEmptyString.nullable(),
});
export type StaffMember = z.infer<typeof staffMemberSchema>;

/** 学年. stage is the school-specific grouping (前期課程など), if any. */
export const gradeSchema = z.object({
  ...masterBase,
  name: nonEmptyString,
  sortOrder: z.number().int(),
  stage: nonEmptyString.nullable(),
});
export type Grade = z.infer<typeof gradeSchema>;

/** クラス. */
export const schoolClassSchema = z.object({
  ...masterBase,
  gradeId: nonEmptyString,
  name: nonEmptyString,
  sortOrder: z.number().int(),
});
export type SchoolClass = z.infer<typeof schoolClassSchema>;

/** 特別支援学級. */
export const specialNeedsClassSchema = z.object({
  ...masterBase,
  name: nonEmptyString,
  sortOrder: z.number().int(),
});
export type SpecialNeedsClass = z.infer<typeof specialNeedsClassSchema>;

/** 日課パターンと時限の時刻. Period numbers must be unique. */
export const dayPatternSchema = z
  .object({
    ...masterBase,
    name: nonEmptyString,
    kind: dayScheduleKindSchema,
    periods: z.array(periodTimeSchema).min(1),
  })
  .refine((v) => new Set(v.periods.map((p) => p.period)).size === v.periods.length, {
    message: "period numbers must be unique within a day pattern",
  });
export type DayPattern = z.infer<typeof dayPatternSchema>;
