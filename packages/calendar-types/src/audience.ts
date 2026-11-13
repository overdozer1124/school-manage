import { z } from "zod";
import type { DatePrecision, Visibility } from "./codes.js";

/**
 * The audience filter for the school calendar (DESIGN-AUTH-TENANCY 4.5,
 * DESIGN-INTEGRATION 6). The prototype kept this logic in the schedule
 * client's audience.ts; the design moves it into this shared package
 * as pure functions, so the platform server (which owns the events)
 * and the product clients apply exactly the same rule. The server is
 * the one that enforces it — a client-side copy is only for display
 * consistency.
 */

/** Who a read is for: a signed-in staff member, or the public
 *  audiences (guardians, students, anyone) that never sign in (D-3). */
export const audienceSchema = z.enum(["staff", "guardian", "student", "public"]);
export type Audience = z.infer<typeof audienceSchema>;

/**
 * How far an event's visibility reaches: staff_only is seen by staff
 * alone, guardian also by guardians, student also by students, public
 * by everyone. An audience sees an event when the event's reach is at
 * least the audience's floor.
 */
const VISIBILITY_REACH: Record<Visibility, number> = {
  staff_only: 0,
  guardian: 1,
  student: 2,
  public: 3,
};
const AUDIENCE_FLOOR: Record<Audience, number> = {
  staff: 0,
  guardian: 1,
  student: 2,
  public: 3,
};

/** True when an event with this visibility may be shown to `audience`. */
export function isVisibleTo(visibility: Visibility, audience: Audience): boolean {
  return VISIBILITY_REACH[visibility] >= AUDIENCE_FLOOR[audience];
}

/** The events of a list that `audience` may see, order preserved. */
export function filterVisible<T extends { visibility: Visibility }>(
  events: readonly T[],
  audience: Audience,
): T[] {
  return events.filter((event) => isVisibleTo(event.visibility, audience));
}

function isStaffTarget(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { axis?: unknown }).axis === "staff"
  );
}

/**
 * The shape of an event handed to `audience`. Assignee names (staff
 * ids and free-text names alike) are staff-only information
 * (DESIGN-AUTH-TENANCY 4.5: 職員以外に担当者名を返さない), so for
 * every other audience the assignees are dropped entirely. Staff ids
 * are likewise staff-only wherever they appear as a target, so for
 * other audiences the staff-axis entries are also dropped from
 * `targets` and from the targets of block_periods impacts. The
 * creator / updater person ids (createdBy / updatedBy) are stripped
 * one layer up, where the response is serialized: this record shape
 * still carries them because the shared schema requires them.
 */
export function forAudience<T extends { assignees: readonly unknown[] }>(
  event: T,
  audience: Audience,
): T {
  if (audience === "staff") return event;
  const result: Record<string, unknown> = {
    ...(event as Record<string, unknown>),
    assignees: [],
  };
  if (Array.isArray(result.targets)) {
    result.targets = result.targets.filter((target) => !isStaffTarget(target));
  }
  if (Array.isArray(result.impacts)) {
    result.impacts = result.impacts.map((impact) => {
      if (
        typeof impact === "object" &&
        impact !== null &&
        (impact as { kind?: unknown }).kind === "block_periods" &&
        Array.isArray((impact as { targets?: unknown }).targets)
      ) {
        const copy = { ...(impact as Record<string, unknown>) };
        copy.targets = (copy.targets as unknown[]).filter((target) => !isStaffTarget(target));
        return copy;
      }
      return impact;
    });
  }
  return result as T;
}

/** The date fields that decide where an event falls on the calendar. */
export interface EventDates {
  datePrecision: DatePrecision;
  startsOn: string | null;
  endsOn: string | null;
}

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The concrete date span an event occupies, or null when it has no
 * concrete span (datePrecision "undecided": its startsOn is April 1
 * of its school year and only the year has meaning, so there is no
 * day or month to place it on). A month-precision event occupies its
 * whole month: only the year and month of startsOn carry meaning
 * (schedule DESIGN 4.5), whatever day was stored.
 */
export function eventDateSpan(event: EventDates): { start: string; end: string } | null {
  if (event.datePrecision === "undecided" || event.startsOn === null) return null;
  if (event.datePrecision === "month") {
    const year = Number(event.startsOn.slice(0, 4));
    const month = Number(event.startsOn.slice(5, 7));
    return {
      start: `${event.startsOn.slice(0, 8)}01`,
      end: lastDayOfMonth(year, month),
    };
  }
  return { start: event.startsOn, end: event.endsOn ?? event.startsOn };
}

/**
 * True when the queried range covers a whole school year
 * (April 1 to the next March 31). Undecided events belong to one
 * school year rather than to any month, so a range query returns
 * them only when it asks for that full year (Issue #24: month／
 * undecided の行事もその月や年度の範囲で返す).
 */
export function coversSchoolYear(from: string, to: string): boolean {
  const fromYear = Number(from.slice(0, 4));
  for (const year of [fromYear - 1, fromYear]) {
    if (from <= `${year}-04-01` && to >= `${year + 1}-03-31`) return true;
  }
  return false;
}

/** True when [from, to] covers the whole school year that starts in
 *  `year` (April 1 of `year` to March 31 of `year + 1`). */
export function coversSchoolYearOf(from: string, to: string, year: number): boolean {
  return from <= `${year}-04-01` && to >= `${year + 1}-03-31`;
}

/** True when an event belongs in the queried [from, to] date range. */
export function eventInRange(event: EventDates, from: string, to: string): boolean {
  if (event.datePrecision === "undecided") {
    // The event belongs to the school year named by startsOn (April 1
    // of that year; only the year has meaning). It is returned only
    // when the query covers that whole year — never for other years.
    // An undecided event without startsOn names no year and belongs
    // to none (the schema requires startsOn; this is defensive).
    if (event.startsOn === null) return false;
    return coversSchoolYearOf(from, to, Number(event.startsOn.slice(0, 4)));
  }
  const span = eventDateSpan(event);
  if (span === null) return false;
  return span.start <= to && span.end >= from;
}
