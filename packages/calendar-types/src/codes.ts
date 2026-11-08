import { z } from "zod";

/**
 * Fixed semantic codes (DESIGN-INTEGRATION 8-1-1). The timetable only ever
 * looks at these few codes. A school may define its own subdivisions under
 * a fixed code (for example "年休" under "leave"); see subdivisionSchema.
 * Only APIs that exist in both zod 3 and zod 4 are used in this package,
 * so it can be consumed by school-timetable (zod 3) as well.
 */

const code = <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

/** 日の種別：授業日／休業日／長期休業／登校日／行事日 */
export const dayTypeSchema = code([
  "class_day",
  "closed_day",
  "long_vacation",
  "attendance_day",
  "event_day",
]);
export type DayType = z.infer<typeof dayTypeSchema>;

/** 日課の種類：通常／短縮／考査／特別 */
export const dayScheduleKindSchema = code(["normal", "shortened", "exam", "special"]);
export type DayScheduleKind = z.infer<typeof dayScheduleKindSchema>;

/** 不在の種類 (matches school-timetable lesson_cover_cases.absence_type). */
export const absenceKindSchema = code(["business_trip", "training", "leave", "other"]);
export type AbsenceKind = z.infer<typeof absenceKindSchema>;

/** 行事の種別：行事／会議／考査／〆切／その他 */
export const eventKindSchema = code(["event", "meeting", "exam", "deadline", "other"]);
export type EventKind = z.infer<typeof eventKindSchema>;

/** 影響の種類 (DESIGN-INTEGRATION 2.2). */
export const impactKindSchema = code(["block_periods", "replace_periods", "room_use"]);
export type ImpactKind = z.infer<typeof impactKindSchema>;

/** 公開範囲：職員のみ／保護者／生徒／公開 (schedule DESIGN: visibility). */
export const visibilitySchema = code(["staff_only", "guardian", "student", "public"]);
export type Visibility = z.infer<typeof visibilitySchema>;

/** 確定度：仮／確定 (DESIGN-AUTH-TENANCY D-6). */
export const certaintySchema = code(["tentative", "confirmed"]);
export type Certainty = z.infer<typeof certaintySchema>;

/** Which product a change was made from (updated_via / event actor). */
export const productSchema = code(["platform", "schedule", "timetable"]);
export type Product = z.infer<typeof productSchema>;

/** Weekday, used by weekday_swap. */
export const weekdaySchema = code(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof weekdaySchema>;

export const nonEmptyString = z.string().min(1);

/**
 * A school-specific subdivision under a fixed code:
 * `{ code, key, label }`, for example `{ code: "leave", key: "annual",
 * label: "年休" }`. `key` is stable within the school; `label` is the
 * school's own wording.
 */
export const subdivisionSchema = <C extends z.ZodTypeAny>(codeSchema: C) =>
  z.object({
    code: codeSchema,
    key: nonEmptyString,
    label: nonEmptyString,
  });

export const absenceSubdivisionSchema = subdivisionSchema(absenceKindSchema);
export type AbsenceSubdivision = z.infer<typeof absenceSubdivisionSchema>;
