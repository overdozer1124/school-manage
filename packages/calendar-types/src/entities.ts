import { z } from "zod";
import {
  absenceKindSchema,
  certaintySchema,
  dayTypeSchema,
  eventKindSchema,
  nonEmptyString,
  productSchema,
  visibilitySchema,
  weekdaySchema,
} from "./codes.js";
import { calendarTimeSchema, dateStringSchema } from "./time.js";
import { targetRefSchema } from "./targets.js";

/** Fields every school-calendar entity carries (optimistic locking by
 *  revision, DESIGN-INTEGRATION 3.1). */
export const entityMetaSchema = z.object({
  schoolId: nonEmptyString,
  id: nonEmptyString,
  revision: z.number().int().min(1),
  updatedBy: nonEmptyString,
  updatedVia: productSchema,
});
export type EntityMeta = z.infer<typeof entityMetaSchema>;

/** A day of the school calendar (2.1). dayScheduleId points at a day
 *  pattern of the shared master; null means the school's default pattern. */
export const calendarDaySchema = entityMetaSchema.extend({
  date: dateStringSchema,
  dayType: dayTypeSchema,
  dayScheduleId: nonEmptyString.nullable(),
  weekdaySwap: weekdaySchema.nullable(),
});
export type CalendarDay = z.infer<typeof calendarDaySchema>;

// No .refine here: zod 3's discriminatedUnion rejects refined options,
// so the range check lives in the superRefine on eventImpactSchema below.
const periodRange = z.object({
  from: z.number().int().min(1),
  to: z.number().int().min(1),
});

/** How an event affects the timetable (2.2). No impacts = display only. */
export const eventImpactSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("block_periods"),
      periods: periodRange,
      targets: z.array(targetRefSchema),
    }),
    z.object({
      kind: z.literal("replace_periods"),
      periods: periodRange,
      /** 数える／数えない／自動 */
      countsAs: z.enum(["count", "not_count", "auto"]),
      label: nonEmptyString.nullable(),
    }),
    z.object({
      kind: z.literal("room_use"),
      roomId: nonEmptyString,
      time: calendarTimeSchema,
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.kind !== "room_use" && v.periods.to < v.periods.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "period range: to must be >= from",
        path: ["periods", "to"],
      });
    }
  });
export type EventImpact = z.infer<typeof eventImpactSchema>;

/** An event of the school calendar (2.2). */
export const calendarEventSchema = entityMetaSchema
  .extend({
    title: nonEmptyString,
    kind: eventKindSchema,
    date: dateStringSchema,
    endDate: dateStringSchema.nullable(),
    time: calendarTimeSchema,
    location: nonEmptyString.nullable(),
    assigneeIds: z.array(nonEmptyString),
    visibility: visibilitySchema,
    certainty: certaintySchema,
    impacts: z.array(eventImpactSchema),
  })
  .refine((v) => v.endDate === null || v.endDate >= v.date, {
    message: "endDate must not be before date",
  });
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

const absenceBase = {
  /** Shared-master staff id. */
  staffId: nonEmptyString,
  fromDate: dateStringSchema,
  toDate: dateStringSchema,
  time: calendarTimeSchema,
  kind: absenceKindSchema,
  certainty: certaintySchema,
};

/** A staff absence (2.3). subdivisionKey is the key of a school-specific
 *  subdivision under kind (for example "annual" under "leave"). */
export const absenceSchema = entityMetaSchema
  .extend({ ...absenceBase, subdivisionKey: nonEmptyString.nullable() })
  .refine((v) => v.toDate >= v.fromDate, { message: "toDate must not be before fromDate" });
export type Absence = z.infer<typeof absenceSchema>;

/**
 * The shape handed to the timetable: the leave subdivision is private
 * (DESIGN-AUTH-TENANCY D-5), so this schema has no subdivisionKey at all
 * and parsing an Absence with it drops the field.
 */
export const absencePublicSchema = entityMetaSchema
  .extend(absenceBase)
  .refine((v) => v.toDate >= v.fromDate, { message: "toDate must not be before fromDate" });
export type AbsencePublic = z.infer<typeof absencePublicSchema>;
