import { z } from "zod";
import {
  calendarDaySchema,
  calendarTimeSchema,
  certaintySchema,
  datePrecisionSchema,
  dateStringSchema,
  eventAssigneeSchema,
  eventImpactSchema,
  eventKindSchema,
  gradeRecordSchema,
  holidaySchema,
  nonEmptyString,
  targetRefSchema,
  visibilitySchema,
} from "@school-manage/calendar-types";

/**
 * The response shapes of the platform's public-read path (Issue #82,
 * DESIGN-AUTH-TENANCY 4.5, DESIGN-INTEGRATION 6). They are defined
 * here, separately from the records the member API speaks in, so
 * what leaves this path is decided by these schemas and not by
 * whatever the internal records happen to carry: no school id (the
 * request named the school; the answer is that school's alone), no
 * revision, and no creator / updater stamps — person ids in any
 * form are staff information (職員以外に返さないもの).
 *
 * The audiences a public read may name. Staff is not one of them:
 * a read for staff goes through the member API with a session, so
 * naming staff here is a bad request, refused before any data is
 * read.
 */
export const publicAudienceSchema = z.enum(["guardian", "student", "public"]);
export type PublicAudience = z.infer<typeof publicAudienceSchema>;

/** The school itself: the name the public page shows, and its slug. */
export const publicSchoolSchema = z.object({
  schoolId: nonEmptyString,
  name: nonEmptyString,
  slug: z.string().nullable(),
});
export type PublicSchool = z.infer<typeof publicSchoolSchema>;

const recordMetaToDrop = {
  schoolId: true,
  revision: true,
  updatedBy: true,
  updatedVia: true,
} as const;

/** A recorded day of the school calendar, public shape. */
export const publicCalendarDaySchema = calendarDaySchema.omit(recordMetaToDrop);
export type PublicCalendarDay = z.infer<typeof publicCalendarDaySchema>;

/** A holiday on the school's list, public shape. */
export const publicHolidaySchema = holidaySchema.omit(recordMetaToDrop);
export type PublicHoliday = z.infer<typeof publicHolidaySchema>;

/** A grade of the school (the axis the per-grade values name),
 *  public shape. Grades name classes of children, never people. */
export const publicGradeSchema = gradeRecordSchema.omit(recordMetaToDrop);
export type PublicGrade = z.infer<typeof publicGradeSchema>;

/**
 * An event, public shape: the event's own fields and nothing else.
 * The assignees field stays in the shape (the public bundle
 * carries it) but only ever empty, and that is guaranteed here,
 * not borrowed from the store: the route replaces whatever the
 * store returned with an empty array, and this schema accepts
 * nothing else — so if the replacement is ever lost, the answer
 * fails closed instead of carrying a name out (assignee names,
 * staff ids and free-text names alike are staff-only,
 * DESIGN-AUTH-TENANCY 4.5; the store's audience shaping emptying
 * them first is a second layer, not the guarantee). The
 * staff-axis targets are dropped by the store's shaping and,
 * on the schedule side, once more by the public layer.
 * Defined field by field because the record schema carries a
 * superRefine and cannot be omit-ed; the field list is the event
 * fields of calendar-types' entities, minus identity and stamps.
 */
export const publicCalendarEventSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
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
  assignees: z.array(eventAssigneeSchema).max(0),
});
export type PublicCalendarEvent = z.infer<typeof publicCalendarEventSchema>;
