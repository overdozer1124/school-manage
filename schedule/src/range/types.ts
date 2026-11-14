import { z } from "zod";
import { dateStringSchema } from "@school-manage/calendar-types";
import type { DailyValueRow, DutyAssignmentRow, EventValueRow } from "../db/schema.js";
import type { ViewDefinitionWithColumns } from "../db/views.js";

/**
 * Payload shapes for the range actions (Issue #33). The cookie is a
 * named field, as in the event relay (Issue #29): the actions layer
 * has no HTTP layer yet, and the platform reads are made with the
 * caller's own session, forwarded as-is.
 */
const nonEmptyString = z.string().min(1);

export const getRangeInputSchema = z
  .object({
    from: dateStringSchema,
    to: dateStringSchema,
    viewId: nonEmptyString,
    cookie: nonEmptyString,
  })
  .refine((v) => v.from <= v.to, { message: "from must be on or before to" });
export type GetRangeInput = z.infer<typeof getRangeInputSchema>;

export const getBootstrapInputSchema = z.object({
  cookie: nonEmptyString,
});
export type GetBootstrapInput = z.infer<typeof getBootstrapInputSchema>;

/**
 * The longest range one getRange call may span: one year. A school
 * year (April 1 to the next March 31) is 365 days, or 366 when it
 * contains a February 29, so 366 admits every single school year —
 * which matters because the platform returns undecided events only
 * to a range that covers their whole school year.
 */
export const MAX_RANGE_DAYS = 366;

/**
 * One day of a range, bundled (DESIGN schedule 4.6: the month table
 * is events + daily values + duty assignments joined by date; the
 * join is computed per read and never stored). `day` is the
 * platform's recorded day for the date, or null when the school has
 * recorded none — readers derive the default (a class day on a
 * weekday, a closed day on a weekend) from the weekday, per Issue
 * #23's convention. Platform records (day, holidays, events,
 * absences) travel in the platform's own shape, untouched: the
 * privacy shaping is the platform's and is passed through, never
 * widened or narrowed here (DESIGN-INTEGRATION 10).
 */
export interface RangeDay {
  date: string;
  day: Record<string, unknown> | null;
  holidays: Record<string, unknown>[];
  events: Record<string, unknown>[];
  absences: Record<string, unknown>[];
  dailyValues: DailyValueRow[];
  dutyAssignments: DutyAssignmentRow[];
}

/**
 * Events whose date is not a day: month precision (only the month
 * is fixed) grouped under that month, and undecided events (only
 * the school year is fixed) under `month: null`. DESIGN schedule
 * 5.2 scenario 9: a month table shows these at its end as that
 * month's undecided events, apart from the days. The platform
 * returns undecided events only when the range covers their whole
 * school year, so a shorter range simply has none to group.
 */
export interface RangeUndecided {
  month: string | null;
  events: Record<string, unknown>[];
}

export interface RangeResult {
  /** The view definition, its columns already filtered to what
   *  the view's audience may see (Issue #32's pure functions). */
  view: ViewDefinitionWithColumns;
  from: string;
  to: string;
  days: RangeDay[];
  undecided: RangeUndecided[];
  /** The additional items (this database) of the events and
   *  absences in the result, joined by the screens on subjectId.
   *  Filtered like the rest of the range: an item the view's
   *  audience may not see contributes no values, and an absence
   *  the platform showed in its restricted shape (no purpose)
   *  contributes none either — the getEventValues rule. */
  eventValues: EventValueRow[];
  /**
   * Duty conflicts (assignment × absence overlaps and the rest of
   * DESIGN schedule 4.7.2). The derivation itself is Issue #31's
   * work; this is the slot it fills, through this same bundling
   * step. Until then it is always empty.
   */
  conflicts: [];
}
