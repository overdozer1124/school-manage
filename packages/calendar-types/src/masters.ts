import { z } from "zod";
import { dayScheduleKindSchema, nonEmptyString, productSchema } from "./codes.js";
import { timeStringSchema, timeToMinutes } from "./time.js";

/** Shared masters (2.4). App-specific leftovers (a timetable's subjects,
 *  a schedule's duty roster) stay in each app; these are the shared core. */

const masterBase = { schoolId: nonEmptyString, id: nonEmptyString };

/** 教職員. personId links to the platform person (login user), if any.
 *  active=false keeps the row (and the references to it) while taking
 *  the person out of new assignments. */
export const staffMemberSchema = z.object({
  ...masterBase,
  name: nonEmptyString,
  shortName: nonEmptyString,
  sortOrder: z.number().int(),
  active: z.boolean(),
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

/**
 * One period of a day pattern, as master data: unlike periodTimeSchema
 * (the lesson periods a calendar time can cover), a pattern may carry
 * the out-of-range bands schools timetable by number — 0 is the
 * morning band, 99 the after-school band — and every band has a
 * display label （朝・放課後など）.
 */
export const dayPatternPeriodSchema = z
  .object({
    period: z.number().int().min(0),
    label: nonEmptyString,
    startsAt: timeStringSchema,
    endsAt: timeStringSchema,
  })
  .refine((v) => timeToMinutes(v.endsAt) > timeToMinutes(v.startsAt), {
    message: "a period must end after it starts",
  });
export type DayPatternPeriod = z.infer<typeof dayPatternPeriodSchema>;

const dayPatternFields = {
  ...masterBase,
  /** The school's own short code for the pattern (A, B, 普, A7…). */
  code: nonEmptyString,
  name: nonEmptyString,
  kind: dayScheduleKindSchema,
  periods: z.array(dayPatternPeriodSchema).min(1),
};

const uniquePeriodNumbers = {
  message: "period numbers must be unique within a day pattern",
};
function hasUniquePeriodNumbers(v: { periods: { period: number }[] }): boolean {
  return new Set(v.periods.map((p) => p.period)).size === v.periods.length;
}

/** 日課パターンと時限の時刻. Period numbers must be unique. */
export const dayPatternSchema = z
  .object(dayPatternFields)
  .refine(hasUniquePeriodNumbers, uniquePeriodNumbers);
export type DayPattern = z.infer<typeof dayPatternSchema>;

/**
 * A master as the platform stores and returns it: the master fields
 * plus the shared entity meta (revision locking and the last-writer
 * stamp, 3.1). The platform masters API speaks in these record
 * shapes; an update sends the record back with the revision the
 * client last saw.
 */
const masterRecordMeta = {
  revision: z.number().int().min(1),
  updatedBy: nonEmptyString,
  updatedVia: productSchema,
};

export const staffMemberRecordSchema = staffMemberSchema.extend(masterRecordMeta);
export type StaffMemberRecord = z.infer<typeof staffMemberRecordSchema>;

export const gradeRecordSchema = gradeSchema.extend(masterRecordMeta);
export type GradeRecord = z.infer<typeof gradeRecordSchema>;

export const schoolClassRecordSchema = schoolClassSchema.extend(masterRecordMeta);
export type SchoolClassRecord = z.infer<typeof schoolClassRecordSchema>;

export const specialNeedsClassRecordSchema = specialNeedsClassSchema.extend(masterRecordMeta);
export type SpecialNeedsClassRecord = z.infer<typeof specialNeedsClassRecordSchema>;

export const dayPatternRecordSchema = z
  .object({ ...dayPatternFields, ...masterRecordMeta })
  .refine(hasUniquePeriodNumbers, uniquePeriodNumbers);
export type DayPatternRecord = z.infer<typeof dayPatternRecordSchema>;
