import {
  addDays,
  datesInRange,
  deriveDutyConflicts,
  dutyAppliesOn,
  resolveDayFacts,
  slotsForGranularity,
  weekStartOf,
  type DutyApplicablePeriod,
  type DutyAssignmentFact,
  type DutyConflict,
  type DutyDayFacts,
  type DutyExpectedCell,
  type DutyGranularity,
  type DutyOrigin,
  type Weekday,
} from "@school-manage/calendar-types";
import * as store from "../db/duties.js";
import * as changeStore from "../db/dutyChanges.js";
import type { DutyAssignmentRow } from "../db/schema.js";
import { tenantDb } from "../db/tenant.js";
import type { DutyPlatformSource } from "./platformSource.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

/** Facts for every date a plan touches: one platform read. */
export async function factsFor(
  platform: DutyPlatformSource | undefined,
  schoolId: string,
  definition: store.DutyDefinitionWithRule,
  range: { from: string; to: string },
): Promise<(date: string) => DutyDayFacts> {
  if (
    definition.applicablePeriod === "all_year" ||
    definition.applicablePeriod === "custom_range"
  ) {
    // The calendar cannot change the answer, so no platform
    // read is needed (or made).
    return (date) => resolveDayFacts(date, undefined, []);
  }
  if (!platform) {
    throw new Error(
      `applicable period "${definition.applicablePeriod}" needs the platform calendar, which is not configured`,
    );
  }
  const [days, terms] = await Promise.all([
    platform.listCalendarDays(schoolId, range),
    definition.applicablePeriod === "term" ? platform.listTerms(schoolId) : Promise.resolve([]),
  ]);
  const recorded = new Map(days.map((d) => [d.date, d.dayType]));
  return (date) => resolveDayFacts(date, recorded.get(date), terms);
}

/** A stored assignment as conflict derivation / candidate ranking
 *  reads it (the origin string the database holds is the shared
 *  enum by check constraint). */
export function toAssignmentFact(row: DutyAssignmentRow): DutyAssignmentFact {
  return {
    id: row.id,
    dutyDefinitionId: row.dutyDefinitionId,
    date: row.date,
    slot: row.slot,
    personId: row.personId,
    origin: row.origin as DutyOrigin,
  };
}

/**
 * The duty conflicts of one range, derived in this one place
 * (Issue #69): the definitions, assignments, absences, waivers
 * and the school's counted absence kinds are read, the cells the
 * definitions are in force on are assembled, and
 * deriveDutyConflicts does the rest. getDutyConflicts (Issue #31)
 * and getRange (Issue #33) both call this, so the same range
 * yields the same conflicts through either read. Without a
 * platform source there is nothing honest to derive from, so
 * this refuses — it never silently returns an empty list.
 */
export async function deriveDutyConflictsForRange(
  db: Db,
  platform: DutyPlatformSource | undefined,
  schoolId: string,
  range: { from: string; to: string },
): Promise<DutyConflict[]> {
  if (!platform) {
    throw new Error("conflict derivation needs the platform source, which is not configured");
  }
  const [definitions, assignments, absences, waivers, absenceKinds] = await Promise.all([
    store.getDutyDefinitions(db, schoolId),
    // A week assignment opening before the range still covers
    // its first days, so the read window opens a week early;
    // derivation expands it and keeps only in-range days.
    store.getAssignments(db, schoolId, { from: addDays(range.from, -7), to: range.to }),
    platform.listAbsences(schoolId, range),
    changeStore.listWaivers(db, schoolId),
    changeStore.getConflictAbsenceKinds(db, schoolId),
  ]);
  const expectedCells: DutyExpectedCell[] = [];
  for (const definition of definitions) {
    // A stopped duty (Issue #86) is not in force: it demands no
    // holders, so it contributes no expected cells and never
    // raises an "unassigned" conflict. Its standing assignments
    // still take part in the absence / double derivation inside
    // deriveDutyConflicts, which reads the assignment rows
    // themselves — those conflicts are facts about records that
    // remain on display, and the waiver flow stays open for them.
    if (!definition.isActive) continue;
    const factsOf = await factsFor(platform, schoolId, definition, range);
    const periodLike = {
      applicablePeriod: definition.applicablePeriod as DutyApplicablePeriod,
      startsOn: definition.applicableStartsOn,
      endsOn: definition.applicableEndsOn,
    };
    const applies = (date: string): boolean => dutyAppliesOn(periodLike, date, factsOf(date));
    if (definition.granularity === "day" || definition.granularity === "am_pm") {
      const slots = slotsForGranularity(definition.granularity as DutyGranularity);
      for (const date of datesInRange(range.from, range.to)) {
        if (!applies(date)) continue;
        for (const slot of slots) {
          expectedCells.push({ dutyDefinitionId: definition.id, date, slot });
        }
      }
    } else if (definition.granularity === "week") {
      const weekStart = (definition.rotation?.changeWeekdays?.[0] as Weekday | undefined) ?? "mon";
      for (
        let date = weekStartOf(range.from, weekStart);
        date <= range.to;
        date = addDays(date, 7)
      ) {
        if (applies(date)) {
          expectedCells.push({ dutyDefinitionId: definition.id, date, slot: "week" });
        }
      }
    }
    // Period duties name their slots through the day pattern,
    // which this layer does not read (the same reason a period
    // rotation takes its slots as input, Issue #30): their
    // unassigned cells are not derived here.
  }
  return deriveDutyConflicts({
    from: range.from,
    to: range.to,
    assignments: assignments.map(toAssignmentFact),
    absences,
    waivers,
    absenceKinds,
    expectedCells,
    dutyNames: Object.fromEntries(definitions.map((d) => [d.id, d.name])),
  });
}
