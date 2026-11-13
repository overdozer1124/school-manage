import { z } from "zod";
import {
  absenceKindSchema,
  certaintySchema,
  datePrecisionSchema,
  dayTypeSchema,
  eventKindSchema,
  holidayKindSchema,
  nonEmptyString,
  productSchema,
  visibilitySchema,
  weekdaySchema,
  type DatePrecision,
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

/** The fields a calendar day carries besides identity and meta. */
const dayFields = {
  date: dateStringSchema,
  dayType: dayTypeSchema,
  /** The school's own word for the day type (8-1-1: a fixed meaning
   *  code plus the school's wording), or null when it has none. */
  dayTypeLabel: nonEmptyString.nullable(),
  /** A day pattern of the shared master; null means the school's
   *  default pattern. */
  dayScheduleId: nonEmptyString.nullable(),
  weekdaySwap: weekdaySchema.nullable(),
  note: z.string().nullable(),
};

/** A day of the school calendar (2.1), as the platform stores and
 *  returns it (Issue #23). Only days a school has recorded exist in
 *  this shape: a date with no row has the default day (a class day on
 *  a weekday, a closed day on a weekend), which the readers derive
 *  from the weekday — the API returns recorded days only. */
export const calendarDaySchema = entityMetaSchema.extend(dayFields);
export type CalendarDay = z.infer<typeof calendarDaySchema>;

/** What a create or update of a day sends: the day without its stamps. */
export const calendarDayInputSchema = z.object({
  schoolId: nonEmptyString,
  id: nonEmptyString,
  ...dayFields,
});
export type CalendarDayInput = z.infer<typeof calendarDayInputSchema>;

/** The fields a holiday carries besides identity and meta. */
const holidayFields = {
  date: dateStringSchema,
  name: nonEmptyString,
  kind: holidayKindSchema,
};

/**
 * A holiday or other non-teaching day kept as its own list (schedule
 * DESIGN 4.1 `holidays`, Issue #23): the material for weekend /
 * holiday colouring and class-day judgement, separate from the day
 * records so a school can keep the official holiday list on its own.
 * A date may carry more than one holiday row (a national holiday that
 * is also a school closed day, say), so the date is not unique here.
 */
export const holidaySchema = entityMetaSchema.extend(holidayFields);
export type Holiday = z.infer<typeof holidaySchema>;

/** What a create or update of a holiday sends. */
export const holidayInputSchema = z.object({
  schoolId: nonEmptyString,
  id: nonEmptyString,
  ...holidayFields,
});
export type HolidayInput = z.infer<typeof holidayInputSchema>;

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

/**
 * One assignee of an event (schedule DESIGN 4.5, event_assignees): a
 * staff member of the shared master, or a free-text name for someone
 * who is not registered (an external helper, an unregistered
 * spelling). role is the school's wording for the part they play
 * （担当／引率など）, or null when no role is recorded.
 */
export const eventAssigneeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("staff"),
    staffId: nonEmptyString,
    role: nonEmptyString.nullable(),
  }),
  z.object({
    kind: z.literal("free_text"),
    name: nonEmptyString,
    role: nonEmptyString.nullable(),
  }),
]);
export type EventAssignee = z.infer<typeof eventAssigneeSchema>;

/** The fields an event carries besides identity and meta. The time is
 *  a CalendarTime stored exactly as entered (DESIGN-INTEGRATION
 *  8-1-2). The location master lives in the schedule app, so the
 *  platform holds a location id as a bare string plus free text
 *  (Issue #24). */
const eventFields = {
  title: nonEmptyString,
  /** The fixed kind code, and the school's own word for it, if any. */
  kind: eventKindSchema,
  kindLabel: nonEmptyString.nullable(),
  datePrecision: datePrecisionSchema,
  startsOn: dateStringSchema.nullable(),
  endsOn: dateStringSchema.nullable(),
  time: calendarTimeSchema.nullable(),
  locationId: nonEmptyString.nullable(),
  locationText: nonEmptyString.nullable(),
  description: z.string().nullable(),
  certainty: certaintySchema,
  visibility: visibilitySchema,
  targets: z.array(targetRefSchema),
  impacts: z.array(eventImpactSchema),
  assignees: z.array(eventAssigneeSchema),
};

interface EventDateFields {
  datePrecision: DatePrecision;
  startsOn: string | null;
  endsOn: string | null;
}

function checkEventDates(v: EventDateFields, ctx: z.RefinementCtx): void {
  const fail = (message: string, path: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
  switch (v.datePrecision) {
    case "day":
      if (v.startsOn === null) fail("a day-precision event needs startsOn", "startsOn");
      else if (v.endsOn !== null && v.endsOn !== v.startsOn)
        fail("a day-precision event ends on its start date", "endsOn");
      break;
    case "range":
      if (v.startsOn === null) fail("a range event needs startsOn", "startsOn");
      else if (v.endsOn === null) fail("a range event needs endsOn", "endsOn");
      else if (v.endsOn < v.startsOn) fail("endsOn must not be before startsOn", "endsOn");
      break;
    case "month":
      if (v.startsOn === null) fail("a month-precision event needs startsOn", "startsOn");
      else if (
        v.endsOn !== null &&
        (v.endsOn < v.startsOn || v.endsOn.slice(0, 7) !== v.startsOn.slice(0, 7))
      )
        fail("a month-precision event ends within its month", "endsOn");
      break;
    case "undecided":
      // An undecided event still belongs to one school year: startsOn
      // carries April 1 of that year and only the year has meaning
      // (the same treatment "month" gives its year and month). Without
      // it, a school-year query could not tell which year the event
      // is undecided for, and it would surface in every year.
      if (v.startsOn === null)
        fail("an undecided event needs startsOn (April 1 of its school year)", "startsOn");
      else if (v.startsOn.slice(5) !== "04-01")
        fail("an undecided event's startsOn is April 1 of its school year", "startsOn");
      if (v.endsOn !== null) fail("an undecided event has no endsOn", "endsOn");
      break;
  }
}

/**
 * An event as the platform stores and returns it (Issue #24): the
 * record the events API speaks in, with the shared entity meta, the
 * creator stamp (createdBy — DESIGN-INTEGRATION 3.1 records who made
 * it as well as who last changed it) and the subordinate targets,
 * impacts and assignees inlined.
 */
export const calendarEventRecordSchema = entityMetaSchema
  .extend({ createdBy: nonEmptyString, ...eventFields })
  .superRefine(checkEventDates);
export type CalendarEventRecord = z.infer<typeof calendarEventRecordSchema>;

/** What a create or update sends: the record without its stamps. The
 *  revision travels alongside on an update, as with the masters. */
export const calendarEventInputSchema = z
  .object({ schoolId: nonEmptyString, id: nonEmptyString, ...eventFields })
  .superRefine(checkEventDates);
export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>;

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
