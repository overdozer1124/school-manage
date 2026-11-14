import { z } from "zod";
import { type AbsenceKind, type Certainty, type DayType, type Weekday } from "./codes.js";
import { addDays, datesInRange, isValidTimeString, weekdayOf, type CalendarTime } from "./time.js";

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

// ---------- conflict derivation (DESIGN schedule 4.7.2, Issue #31) ----

/**
 * Whether an absence occupying part of one date overlaps a duty
 * slot on that date. This is the absence counterpart of eventSlot /
 * slotsOverlap: an absence's span is a CalendarTime (DESIGN-
 * INTEGRATION 2.3), so a half_day absence names its half directly
 * and a clock absence is placed by its hours through eventSlot —
 * a morning-only trip does not clash with an afternoon duty.
 *
 * Two cases cannot be decided exactly without the day pattern's
 * clock times, which this layer does not read: a periods absence
 * against an am/pm duty, and a clock or half_day absence against a
 * single-period duty. Both answer "overlaps" — a conflict is a
 * warning that invites a human look, never a block (4.7.2), so the
 * undecidable case warns. A periods absence against a period duty
 * IS decided exactly, by the period numbers.
 */
export function dutyAbsenceOverlapsSlot(dutySlot: string, time: CalendarTime): boolean {
  if (dutySlot === "week" || dutySlot === "all_day") return true;
  switch (time.kind) {
    case "all_day":
      return true;
    case "half_day":
      if (dutySlot === "am" || dutySlot === "pm") return dutySlot === time.half;
      return true;
    case "clock": {
      if (dutySlot === "am" || dutySlot === "pm") {
        const slot = eventSlot({
          isAllDay: false,
          slot: "all_day",
          startsAt: time.startsAt,
          endsAt: time.endsAt,
        });
        return slotsOverlap(dutySlot, slot);
      }
      return true;
    }
    case "periods": {
      if (PERIOD_SLOT_RE.test(dutySlot)) {
        const n = Number(dutySlot);
        return time.from <= n && n <= time.to;
      }
      return true;
    }
  }
}

/**
 * One platform absence, as conflict derivation reads it (Issue #31):
 * who is away, in which kind, how certain, and over which dates /
 * part of day. The absence's own texts and subdivision never travel
 * here — derivation needs none of them, and a leave's texts stay
 * behind the platform's privacy rules (DESIGN-AUTH-TENANCY 4.5).
 */
export interface DutyAbsenceFact {
  id: string;
  staffId: string;
  kind: AbsenceKind;
  certainty: Certainty;
  fromDate: string;
  toDate: string;
  time: CalendarTime;
}

/** One duty assignment, as conflict derivation reads it. */
export interface DutyAssignmentFact {
  id: string;
  dutyDefinitionId: string;
  date: string;
  slot: string;
  personId: string | null;
  origin: DutyOrigin;
}

/**
 * One cell a duty definition is expected to fill on a date. The
 * caller computes these from the definition's applicable period
 * and the platform calendar (the same facts a rotation preview
 * uses); derivation only checks whether a holder stands there.
 */
export interface DutyExpectedCell {
  dutyDefinitionId: string;
  date: string;
  slot: string;
}

/**
 * One derived conflict (DESIGN schedule 4.7.2). Conflicts are
 * never stored — they are recomputed from the assignments and the
 * absences of the moment, so an absence that disappears takes its
 * conflicts with it. Only the waiver of a conflict is recorded.
 *
 * - absence: the holder is away (in an absence of a kind the
 *   school counts) over the assignment's slot. certainty carries
 *   the absence's own: a tentative absence conflicts too, and is
 *   recognisable as tentative (DESIGN-AUTH-TENANCY 4.6).
 * - double: the same person holds two duties over the same moment
 *   (assignmentId and otherAssignmentId name the pair).
 * - unassigned: a cell the definition is in force on has no
 *   holder. A cell a person deliberately cleared by hand (an empty
 *   manual row, Issue #30) is a decision, not a gap, and does not
 *   appear here.
 */
export interface DutyConflict {
  kind: "absence" | "double" | "unassigned";
  assignmentId: string | null;
  otherAssignmentId: string | null;
  dutyDefinitionId: string;
  dutyName: string;
  date: string;
  slot: string;
  personId: string | null;
  absenceId: string | null;
  absenceKind: AbsenceKind | null;
  certainty: Certainty | null;
}

export interface DeriveDutyConflictsInput {
  from: string;
  to: string;
  /** The school's assignments; a window slightly wider than the
   *  range is fine — week assignments are expanded to their days
   *  and only days inside the range produce conflicts. */
  assignments: readonly DutyAssignmentFact[];
  /** The platform's absences overlapping the range. */
  absences: readonly DutyAbsenceFact[];
  /** (assignmentId, absenceId) pairs a person has waived. */
  waivers: readonly { assignmentId: string; absenceId: string }[];
  /** The absence kinds the school counts as conflicts, or null
   *  when every kind counts (the school's setting, Issue #31). */
  absenceKinds: readonly AbsenceKind[] | null;
  /** Cells the definitions are in force on inside the range. */
  expectedCells: readonly DutyExpectedCell[];
  /** Duty names by definition id, for display. */
  dutyNames: Readonly<Record<string, string>>;
}

/** The dates an assignment covers: a week assignment covers its
 *  seven days, every other slot covers its own date. */
function effectiveDates(a: { date: string; slot: string }): string[] {
  return a.slot === "week" ? datesInRange(a.date, addDays(a.date, 6)) : [a.date];
}

function byCellOrder(a: DutyAssignmentFact, b: DutyAssignmentFact): number {
  return (
    a.date.localeCompare(b.date) ||
    a.dutyDefinitionId.localeCompare(b.dutyDefinitionId) ||
    a.slot.localeCompare(b.slot) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Derives the conflicts of a range from the assignments and the
 * absences, following the prototype's computeConflicts (school-
 * schedule actions.ts), adapted to this implementation: holders
 * and absent staff are matched by staff-master id (there are no
 * free-text holders here), absences come from the platform rather
 * than from events, and the applicable cells are the caller's —
 * this implementation derives a definition's in-force days from
 * the platform calendar, which a pure function cannot read.
 */
export function deriveDutyConflicts(input: DeriveDutyConflictsInput): DutyConflict[] {
  const { from, to } = input;
  const out: DutyConflict[] = [];
  const assignments = [...input.assignments].sort(byCellOrder);
  const waived = new Set(input.waivers.map((w) => `${w.assignmentId}:${w.absenceId}`));
  const counted = (kind: AbsenceKind): boolean =>
    input.absenceKinds === null || input.absenceKinds.includes(kind);
  const inRange = (date: string): boolean => from <= date && date <= to;

  // Absence overlaps.
  for (const a of assignments) {
    if (a.personId === null) continue;
    for (const date of effectiveDates(a)) {
      if (!inRange(date)) continue;
      for (const absence of input.absences) {
        if (absence.staffId !== a.personId) continue;
        if (!counted(absence.kind)) continue;
        if (date < absence.fromDate || date > absence.toDate) continue;
        if (!dutyAbsenceOverlapsSlot(a.slot, absence.time)) continue;
        if (waived.has(`${a.id}:${absence.id}`)) continue;
        out.push({
          kind: "absence",
          assignmentId: a.id,
          otherAssignmentId: null,
          dutyDefinitionId: a.dutyDefinitionId,
          dutyName: input.dutyNames[a.dutyDefinitionId] ?? "",
          date,
          slot: a.slot,
          personId: a.personId,
          absenceId: absence.id,
          absenceKind: absence.kind,
          certainty: absence.certainty,
        });
      }
    }
  }

  // The same person on two duties at the same moment.
  const seenDouble = new Set<string>();
  for (let i = 0; i < assignments.length; i += 1) {
    for (let j = i + 1; j < assignments.length; j += 1) {
      const a = assignments[i] as DutyAssignmentFact;
      const b = assignments[j] as DutyAssignmentFact;
      if (a.personId === null || a.personId !== b.personId) continue;
      if (!slotsOverlap(a.slot, b.slot)) continue;
      const bDates = new Set(effectiveDates(b));
      for (const date of effectiveDates(a)) {
        if (!inRange(date) || !bDates.has(date)) continue;
        const key = `${a.id}:${b.id}:${date}`;
        if (seenDouble.has(key)) continue;
        seenDouble.add(key);
        out.push({
          kind: "double",
          assignmentId: a.id,
          otherAssignmentId: b.id,
          dutyDefinitionId: a.dutyDefinitionId,
          dutyName: input.dutyNames[a.dutyDefinitionId] ?? "",
          date,
          slot: a.slot,
          personId: a.personId,
          absenceId: null,
          absenceKind: null,
          certainty: null,
        });
      }
    }
  }

  // Applicable cells with nobody standing in them.
  const rowByCell = new Map(
    assignments.map((a) => [`${a.dutyDefinitionId}|${a.date}|${a.slot}`, a] as const),
  );
  for (const cell of input.expectedCells) {
    if (!inRange(cell.date)) continue;
    const row = rowByCell.get(`${cell.dutyDefinitionId}|${cell.date}|${cell.slot}`);
    if (row && (row.personId !== null || row.origin === "manual")) continue;
    out.push({
      kind: "unassigned",
      assignmentId: null,
      otherAssignmentId: null,
      dutyDefinitionId: cell.dutyDefinitionId,
      dutyName: input.dutyNames[cell.dutyDefinitionId] ?? "",
      date: cell.date,
      slot: cell.slot,
      personId: null,
      absenceId: null,
      absenceKind: null,
      certainty: null,
    });
  }

  out.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      x.dutyDefinitionId.localeCompare(y.dutyDefinitionId) ||
      x.slot.localeCompare(y.slot) ||
      x.kind.localeCompare(y.kind),
  );
  return out;
}

export interface RankDutyCandidatesInput {
  /** The order "near" is measured in: the definition's rotation
   *  roster, or the staff list's display order when the duty has
   *  no rotation rule. */
  roster: readonly string[];
  /** The holder being replaced: excluded, and the starting point
   *  the cyclic distance is counted from. */
  currentPersonId: string | null;
  /** The dates the occasion spans: one date, or a week
   *  assignment's seven days. */
  dates: readonly string[];
  slot: string;
  /** Absences overlapping the dates (any kind: a person who is
   *  away is not a candidate, whichever kind of absence it is). */
  absences: readonly DutyAbsenceFact[];
  /** Assignments in a window around the dates (any definition);
   *  a person already holding an overlapping duty on one of those
   *  days is not asked to hold a second one. */
  assignments: readonly DutyAssignmentFact[];
}

/**
 * The people who could take over a duty on one occasion, nearest
 * first (DESIGN schedule 4.7.1): no absence over the duty's slot
 * on any of the occasion's days, not already on an overlapping
 * duty on one of those days, and — among those — nearest to the
 * current holder in the rotation order, counting cyclically
 * forward from the holder (the next person in the rotation is
 * the nearest). A holder who is not in the roster counts from
 * its head.
 */
export function rankDutyCandidates(input: RankDutyCandidatesInput): string[] {
  const { roster, currentPersonId, dates, slot } = input;
  const absent = new Set(
    input.absences
      .filter(
        (absence) =>
          dates.some((date) => absence.fromDate <= date && date <= absence.toDate) &&
          dutyAbsenceOverlapsSlot(slot, absence.time),
      )
      .map((absence) => absence.staffId),
  );
  const busy = new Set(
    input.assignments
      .filter(
        (a) =>
          a.personId !== null &&
          effectiveDates(a).some((date) => dates.includes(date)) &&
          slotsOverlap(a.slot, slot),
      )
      .map((a) => a.personId as string),
  );
  const start = currentPersonId === null ? -1 : roster.indexOf(currentPersonId);
  const ordered: string[] = [];
  for (let step = 1; step <= roster.length; step += 1) {
    const personId = roster[(start + step) % roster.length] as string;
    if (personId === currentPersonId) continue;
    if (absent.has(personId) || busy.has(personId)) continue;
    ordered.push(personId);
  }
  return ordered;
}
