import { z } from "zod";
import { weekdaySchema, type Weekday } from "./codes.js";

/** Validation helpers carried over from the prototype (school-schedule
 *  server/src/logic.ts), as suggested by the issue. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= last;
}

/** True for a wall-clock time written as HH:MM (00:00-23:59). */
export function isValidTimeString(s: string): boolean {
  return TIME_RE.test(s);
}

/** "HH:MM" to minutes since midnight. Assumes a valid time string. */
export function timeToMinutes(s: string): number {
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
}

export const dateStringSchema = z
  .string()
  .refine(isValidDateString, { message: "expected a real date as YYYY-MM-DD" });
export type DateString = z.infer<typeof dateStringSchema>;

export const timeStringSchema = z
  .string()
  .refine(isValidTimeString, { message: "expected a time as HH:MM (00:00-23:59)" });
export type TimeString = z.infer<typeof timeStringSchema>;

/**
 * How a time span is written (DESIGN-INTEGRATION 8-1-2). The value is
 * stored exactly as entered; periods are derived from it through the day
 * pattern (see calendarTimeToPeriods).
 */
export const calendarTimeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("all_day") }),
    z.object({ kind: z.literal("half_day"), half: z.enum(["am", "pm"]) }),
    z.object({
      kind: z.literal("clock"),
      startsAt: timeStringSchema,
      endsAt: timeStringSchema.nullable(),
    }),
    z.object({
      kind: z.literal("periods"),
      from: z.number().int().min(1),
      to: z.number().int().min(1),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.kind === "periods" && v.to < v.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "periods.to must be >= periods.from",
        path: ["to"],
      });
    }
  });
export type CalendarTime = z.infer<typeof calendarTimeSchema>;

/** One period of a day pattern: its number and its clock times. */
export const periodTimeSchema = z
  .object({
    period: z.number().int().min(1),
    startsAt: timeStringSchema,
    endsAt: timeStringSchema,
  })
  .refine((v) => timeToMinutes(v.endsAt) > timeToMinutes(v.startsAt), {
    message: "a period must end after it starts",
  });
export type PeriodTime = z.infer<typeof periodTimeSchema>;

const NOON = 12 * 60;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Derives the period numbers a CalendarTime covers, using the period
 * times of the day pattern in force that day (8-1-2). This is the single
 * place where clock times become periods, so a day-pattern change (for
 * example to a shortened day) is followed automatically.
 *
 * - all_day: every period of the day.
 * - half_day: periods overlapping the morning (before 12:00) or the
 *   afternoon (from 12:00). A period spanning noon belongs to both.
 * - clock: periods overlapping [startsAt, endsAt). With endsAt null, the
 *   single period containing startsAt — so a start time falling in a
 *   break between periods (or outside the day's periods) yields an
 *   empty array: no period contains that moment.
 * - periods: the range itself, clipped to periods the day actually has.
 */
export function calendarTimeToPeriods(time: CalendarTime, dayPeriods: PeriodTime[]): number[] {
  const periods = [...dayPeriods].sort((a, b) => a.period - b.period);
  if (time.kind === "periods") {
    return periods.map((p) => p.period).filter((n) => n >= time.from && n <= time.to);
  }
  if (time.kind === "all_day") {
    return periods.map((p) => p.period);
  }
  if (time.kind === "half_day") {
    const start = time.half === "am" ? 0 : NOON;
    const end = time.half === "am" ? NOON : 24 * 60;
    return periods
      .filter((p) => overlaps(timeToMinutes(p.startsAt), timeToMinutes(p.endsAt), start, end))
      .map((p) => p.period);
  }
  const start = timeToMinutes(time.startsAt);
  if (time.endsAt === null) {
    return periods
      .filter((p) => timeToMinutes(p.startsAt) <= start && start < timeToMinutes(p.endsAt))
      .map((p) => p.period);
  }
  const end = timeToMinutes(time.endsAt);
  return periods
    .filter((p) => overlaps(timeToMinutes(p.startsAt), timeToMinutes(p.endsAt), start, end))
    .map((p) => p.period);
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Adds n days to a YYYY-MM-DD date (UTC arithmetic, so no DST drift). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return formatDate(new Date(Date.UTC(y, m - 1, d + n)));
}

/** Every date from `from` to `to` inclusive, ascending; empty when to < from. */
export function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The weekday a date falls on, without any swap applied. */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as Weekday;
}

/**
 * The weekday to use for a date: the swap when one is set ("11/9 (Mon) is
 * run as Wednesday's timetable"), otherwise the date's own weekday.
 */
export function effectiveWeekday(date: string, weekdaySwap: Weekday | null | undefined): Weekday {
  return weekdaySwap ?? weekdayOf(date);
}

/**
 * The first day of the week containing a date, where the week starts
 * on weekStart (Monday by default; a Friday-changeover week duty
 * passes "fri", DESIGN schedule 4.7's 週番の金曜交代).
 */
export function weekStartOf(date: string, weekStart: Weekday = "mon"): string {
  const dayIndex = WEEKDAYS.indexOf(weekdayOf(date));
  const startIndex = WEEKDAYS.indexOf(weekStart);
  return addDays(date, -((dayIndex - startIndex + 7) % 7));
}

export { weekdaySchema };
export type { Weekday };
