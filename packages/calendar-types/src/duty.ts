import { z } from "zod";
import { type DayType, type Weekday } from "./codes.js";
import { isValidTimeString, weekdayOf } from "./time.js";

/**
 * Duty (当番) shared logic (DESIGN schedule 4.7, Issue #30). The slot,
 * applicable-period and rotation functions are carried over from the
 * prototype (school-schedule server/src/logic.ts) and adapted to this
 * implementation's types: person ids are the platform's staff-master
 * ids (strings, DESIGN-INTEGRATION 2.4), and whether a date is a long
 * vacation or inside a term comes from the platform's calendar (its
 * day types and its terms), not from dates configured on the duty
 * definition itself — the Issue's rule, which supersedes the
 * prototype's configured-range reading of long_vacation_only.
 */

/** How a duty repeats within its unit (DESIGN schedule 4.7). */
export const dutyGranularitySchema = z.enum(["day", "am_pm", "week", "period"]);
export type DutyGranularity = z.infer<typeof dutyGranularitySchema>;

/** When a duty definition is in force (DESIGN schedule 4.7). */
export const dutyApplicablePeriodSchema = z.enum([
  "all_year",
  "term",
  "long_vacation_only",
  "custom_range",
]);
export type DutyApplicablePeriod = z.infer<typeof dutyApplicablePeriodSchema>;

/** How an assignment came to be (DESIGN schedule 4.7, AUTH-TENANCY 4.7). */
export const dutyOriginSchema = z.enum(["auto", "manual", "swap"]);
export type DutyOrigin = z.infer<typeof dutyOriginSchema>;

/**
 * The fixed slots of a granularity. "period" has none: its slots are
 * the day pattern's period numbers, which only the day itself knows,
 * so callers name them per generation. The week slot is the literal
 * "week" (the assignment's date is the week's first day).
 */
export function slotsForGranularity(granularity: DutyGranularity): string[] {
  switch (granularity) {
    case "day":
      return ["all_day"];
    case "am_pm":
      return ["am", "pm"];
    case "week":
      return ["week"];
    case "period":
      return [];
  }
}

const PERIOD_SLOT_RE = /^[0-9]+$/;

/** Whether a slot string fits a granularity (DESIGN schedule 4.7). */
export function isDutySlot(granularity: DutyGranularity, slot: string): boolean {
  if (granularity === "period") return PERIOD_SLOT_RE.test(slot);
  return slotsForGranularity(granularity).includes(slot);
}

/** Whether two slots can hold the same moment (prototype logic.ts). */
export function slotsOverlap(a: string, b: string): boolean {
  if (a === "week" || b === "week") return true;
  if (a === "all_day" || b === "all_day") return true;
  return a === b;
}

/** Noon boundary that splits 午前 / 午後 for timed events. */
const NOON = "12:00";

/**
 * The part of the day an event occupies, for duty-conflict matching
 * (DESIGN schedule 4.7.2: a morning-only trip does not conflict with
 * an afternoon duty). An explicit am/pm slot wins; otherwise a timed
 * event is placed by its hours — ending by noon is "am", starting
 * at/after noon is "pm", anything spanning noon (or with unknown
 * times) is "all_day". Carried over from the prototype, with
 * isAllDay as a boolean (the prototype's sqlite 0/1).
 */
export function eventSlot(e: {
  isAllDay: boolean;
  slot: string;
  startsAt: string | null;
  endsAt: string | null;
}): string {
  if (e.slot === "am" || e.slot === "pm") return e.slot;
  if (e.isAllDay) return "all_day";
  const s = e.startsAt && isValidTimeString(e.startsAt) ? e.startsAt : null;
  const t = e.endsAt && isValidTimeString(e.endsAt) ? e.endsAt : null;
  if (s && t && t <= NOON) return "am";
  if (s && s >= NOON) return "pm";
  if (!s && t && t <= NOON) return "am";
  return "all_day";
}

/** A term of the platform's school calendar, as a date range. */
export interface DutyTermRange {
  startsOn: string;
  endsOn: string;
}

/** Whether a date falls inside any of the school's terms. */
export function isInTerm(date: string, terms: readonly DutyTermRange[]): boolean {
  return terms.some((t) => t.startsOn <= date && date <= t.endsOn);
}

/**
 * The day type of a date the platform has no record for: a class day
 * on a weekday, a closed day on a weekend. This is the platform
 * calendar API's own convention (Issue #23): its range reads return
 * recorded days only, and readers derive the rest from the weekday.
 */
export function defaultDayType(date: string): DayType {
  const weekday = weekdayOf(date);
  return weekday === "sat" || weekday === "sun" ? "closed_day" : "class_day";
}

/** What the platform calendar says about one date, for duty purposes. */
export interface DutyDayFacts {
  dayType: DayType;
  inTerm: boolean;
}

/**
 * Combines a recorded day type (undefined when the platform has no
 * record for the date) and the school's terms into the facts
 * dutyAppliesOn reads.
 */
export function resolveDayFacts(
  date: string,
  recordedDayType: DayType | undefined,
  terms: readonly DutyTermRange[],
): DutyDayFacts {
  return {
    dayType: recordedDayType ?? defaultDayType(date),
    inTerm: isInTerm(date, terms),
  };
}

/** The part of a duty definition dutyAppliesOn reads. */
export interface DutyPeriodLike {
  applicablePeriod: DutyApplicablePeriod;
  /** Range start for custom_range; null leaves that end open. */
  startsOn: string | null;
  /** Range end for custom_range; null leaves that end open. */
  endsOn: string | null;
}

/**
 * Whether a duty definition is in force on a date.
 *
 * - all_year: always.
 * - custom_range: inside the configured dates; with no dates
 *   configured it applies nowhere, rather than silently applying all
 *   year and flooding the unassigned-duty warnings (the prototype's
 *   rule, kept).
 * - long_vacation_only: the platform calendar marks the date as a
 *   long vacation (day type), however the school recorded it.
 * - term: the date is inside one of the school's terms.
 */
export function dutyAppliesOn(def: DutyPeriodLike, date: string, facts: DutyDayFacts): boolean {
  switch (def.applicablePeriod) {
    case "all_year":
      return true;
    case "long_vacation_only":
      return facts.dayType === "long_vacation";
    case "term":
      return facts.inTerm;
    case "custom_range": {
      if (!def.startsOn && !def.endsOn) return false;
      if (def.startsOn && date < def.startsOn) return false;
      if (def.endsOn && date > def.endsOn) return false;
      return true;
    }
  }
}

/**
 * Where a rotation should resume so that regenerating month by month
 * continues the cycle instead of restarting at the first member: the
 * member after whoever held the most recent assignment before the
 * period. Falls back to 0 when nothing earlier matches a member
 * (prototype logic.ts, with staff-master id strings).
 */
export function nextRotationIndex(
  memberIds: readonly string[],
  lastPersonId: string | null,
): number {
  if (!lastPersonId || memberIds.length === 0) return 0;
  const i = memberIds.indexOf(lastPersonId);
  return i < 0 ? 0 : (i + 1) % memberIds.length;
}

/** One cell a rotation fills: a date and one of its slots. */
export interface RotationCell {
  date: string;
  slot: string;
}

export interface PlannedDutyAssignment extends RotationCell {
  personId: string;
}

/**
 * Lays the rotation over the given cells (which the caller supplies
 * in date order, slots in display order within a date).
 *
 * Without change weekdays the holder advances at every cell, so an
 * am_pm duty has different people in the morning and the afternoon
 * (DESIGN 5.2 scenario 4). With change weekdays named, the holder
 * advances once per date and only on those weekdays; other dates
 * repeat the current holder for all of their slots — the weekday
 * the duty changes hands (交代曜日), as in 週番の金曜交代. The first
 * date always starts at startIndex without advancing.
 */
export function planRotation(
  memberIds: readonly string[],
  startIndex: number,
  cells: readonly RotationCell[],
  changeWeekdays?: readonly Weekday[],
): PlannedDutyAssignment[] {
  if (memberIds.length === 0 || cells.length === 0) return [];
  const start = ((startIndex % memberIds.length) + memberIds.length) % memberIds.length;
  const planned: PlannedDutyAssignment[] = [];
  let index = start;
  let lastDate: string | null = null;
  for (const cell of cells) {
    if (lastDate !== null && cell.date !== lastDate) {
      if (changeWeekdays && changeWeekdays.length > 0) {
        if (changeWeekdays.includes(weekdayOf(cell.date))) {
          index = (index + 1) % memberIds.length;
        }
      } else {
        index = (index + 1) % memberIds.length;
      }
    } else if (lastDate !== null && !(changeWeekdays && changeWeekdays.length > 0)) {
      // Same date, next slot: advance per cell unless change
      // weekdays pin the holder for the whole date.
      index = (index + 1) % memberIds.length;
    }
    planned.push({ ...cell, personId: memberIds[index] as string });
    lastDate = cell.date;
  }
  return planned;
}
