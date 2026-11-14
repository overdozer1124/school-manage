import { AuthAccessError, defineActions } from "@school-manage/platform-client";
import {
  addDays,
  datesInRange,
  deriveDutyConflicts,
  dutyAppliesOn,
  isDutySlot,
  rankDutyCandidates,
  resolveDayFacts,
  slotsForGranularity,
  weekStartOf,
  type DutyApplicablePeriod,
  type DutyAssignmentFact,
  type DutyDayFacts,
  type DutyExpectedCell,
  type DutyGranularity,
  type DutyOrigin,
  type Weekday,
} from "@school-manage/calendar-types";
import * as store from "../db/duties.js";
import * as changeStore from "../db/dutyChanges.js";
import type { DutyAssignmentRow } from "../db/schema.js";
import { targetGroups, targets } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import type { DutyPlatformSource } from "./platformSource.js";
import {
  deleteDutyInputSchema,
  dutyChangeIdInputSchema,
  dutyDefinitionInputSchema,
  getDutyAssignmentsInputSchema,
  getDutyChangeCandidatesInputSchema,
  getDutyChangesInputSchema,
  getDutyConflictsInputSchema,
  proposeDutyChangeInputSchema,
  rotationRangeInputSchema,
  setDutyAssignmentInputSchema,
  waiveConflictInputSchema,
  type RotationRangeInput,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

/**
 * The duty actions (Issue #30), declared with the permissions of
 * DESIGN-AUTH-TENANCY 4.4: definitions change under definition.write
 * (Admin only), assignments are read under view.read (staff only —
 * every product role is a staff role; duties never reach a public
 * audience), and setting / previewing / applying are duty.write.
 *
 * 4.4 gives Viewer a △ on duty.write — their own assignments'
 * swap proposals only. Since Issue #31 the proposals exist
 * (proposeDutyChange), and the △ is enforced there per row: a
 * Viewer's proposal must start from an assignment they hold
 * (matched by teacherId against the staff master, DESIGN-
 * INTEGRATION 10). Setting and applying still refuse Viewers
 * here, as 4.3 prescribes for △ permissions.
 *
 * The platform source supplies what this database cannot know:
 * the staff roster (a rotation naming another school's teacher is
 * refused against it) and the calendar facts behind the
 * long_vacation_only / term periods. Operations that need facts
 * the source cannot give are refused with the reason, never
 * silently approximated.
 */
export function createDutyActions(db: Db, platform?: DutyPlatformSource) {
  async function requireStaffIds(schoolId: string): Promise<ReadonlySet<string>> {
    if (!platform) {
      throw new Error("staff validation needs the platform source, which is not configured");
    }
    const staff = await platform.listStaff(schoolId);
    return new Set(staff.map((s) => s.id));
  }

  async function assertStaffMember(schoolId: string, personId: string): Promise<void> {
    const ids = await requireStaffIds(schoolId);
    if (!ids.has(personId)) {
      throw new Error(`person is not a staff member of this school: ${personId}`);
    }
  }

  function requireWriterRole(role: string): void {
    if (role === "Viewer") {
      throw new AuthAccessError(403, "権限がありません");
    }
  }

  async function loadDefinition(schoolId: string, id: string) {
    const definition = await store.getDutyDefinition(db, schoolId, id);
    if (!definition) {
      throw new Error(`duty definition not found: ${id}`);
    }
    return definition;
  }

  /** Facts for every date a plan touches: one platform read. */
  async function factsFor(
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

  async function buildPlan(schoolId: string, input: RotationRangeInput) {
    const definition = await loadDefinition(schoolId, input.dutyDefinitionId);
    if (!definition.rotation || definition.rotation.personIds.length === 0) {
      throw new Error(`duty definition has no rotation rule: ${definition.id}`);
    }
    const granularity = definition.granularity as DutyGranularity;
    let slots: string[];
    if (granularity === "period") {
      slots = [...(input.slots ?? [])].sort((a, b) => Number(a) - Number(b));
      if (slots.length === 0) {
        throw new Error("a period duty's rotation needs the period numbers to fill (slots)");
      }
    } else {
      slots = slotsForGranularity(granularity);
    }
    for (const slot of slots) {
      if (!isDutySlot(granularity, slot)) {
        throw new Error(`slot "${slot}" does not fit granularity "${definition.granularity}"`);
      }
    }
    const range = { from: input.from, to: input.to };
    const factsOf = await factsFor(schoolId, definition, range);
    return store.buildRotationPlan(db, schoolId, { definition, range, slots, factsOf });
  }

  return defineActions({
    getDutyDefinitions: scheduleAction("view.read", async ({ auth }) =>
      store.getDutyDefinitions(db, auth.schoolId),
    ),

    upsertDutyDefinition: scheduleAction("definition.write", async ({ auth, request }) => {
      const input = dutyDefinitionInputSchema.parse(request);
      if (input.targetGroupId) {
        const tdb = tenantDb(db, auth.schoolId);
        await assertOwned(tdb, targetGroups, [input.targetGroupId]);
      }
      if (input.rotation) {
        // The roster names the platform's staff masters; a teacher
        // of another school (or no school) is refused here, before
        // anything is written.
        const ids = await requireStaffIds(auth.schoolId);
        const unknown = input.rotation.personIds.filter((id) => !ids.has(id));
        if (unknown.length > 0) {
          throw new Error(
            `rotation names people who are not staff of this school: ${unknown.join(", ")}`,
          );
        }
      }
      return store.upsertDutyDefinition(db, auth.schoolId, input);
    }),

    deleteDutyDefinition: scheduleAction("definition.write", async ({ auth, request }) => {
      const { id } = deleteDutyInputSchema.parse(request);
      if (!(await store.deleteDutyDefinition(db, auth.schoolId, id))) {
        throw new Error(`duty definition not found: ${id}`);
      }
      return { deleted: true };
    }),

    getDutyAssignments: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getDutyAssignmentsInputSchema.parse(request);
      return store.getAssignments(db, auth.schoolId, input);
    }),

    setDutyAssignment: scheduleAction("duty.write", async ({ auth, request }) => {
      requireWriterRole(auth.role);
      const input = setDutyAssignmentInputSchema.parse(request);
      const definition = await loadDefinition(auth.schoolId, input.dutyDefinitionId);
      if (!isDutySlot(definition.granularity as DutyGranularity, input.slot)) {
        throw new Error(
          `slot "${input.slot}" does not fit granularity "${definition.granularity}"`,
        );
      }
      const personId = input.personId ?? null;
      const targetId = input.targetId ?? null;
      if (personId) await assertStaffMember(auth.schoolId, personId);
      if (targetId) {
        const tdb = tenantDb(db, auth.schoolId);
        await assertOwned(tdb, targets, [targetId]);
        const target = await tdb.findById(targets, targetId);
        if (!definition.targetGroupId || target?.targetGroupId !== definition.targetGroupId) {
          throw new Error(`target does not belong to the duty's target group: ${targetId}`);
        }
      }
      if (personId && definition.targetGroupId) {
        throw new Error("a duty on a target group takes a target, not a person");
      }
      // Naming no holder empties the cell; the store keeps an
      // empty manual row for it, and that row is what returns.
      return store.setAssignment(
        db,
        auth.schoolId,
        {
          dutyDefinitionId: definition.id,
          date: input.date,
          slot: input.slot,
          personId,
          targetId,
          note: input.note ?? null,
        },
        auth.userId,
      );
    }),

    previewRotation: scheduleAction("duty.write", async ({ auth, request }) => {
      const input = rotationRangeInputSchema.parse(request);
      return buildPlan(auth.schoolId, input);
    }),

    applyRotation: scheduleAction("duty.write", async ({ auth, request }) => {
      requireWriterRole(auth.role);
      const input = rotationRangeInputSchema.parse(request);
      const plan = await buildPlan(auth.schoolId, input);
      return store.applyRotationPlan(db, auth.schoolId, input.dutyDefinitionId, plan, auth.userId);
    }),

    // ---- Duty changes and conflicts (Issue #31) ------------------

    proposeDutyChange: scheduleAction("duty.write", async ({ auth, request }) => {
      const input = proposeDutyChangeInputSchema.parse(request);
      const a = await changeStore.getAssignmentById(db, auth.schoolId, input.assignmentAId);
      if (!a) {
        throw new Error(`duty assignment not found: ${input.assignmentAId}`);
      }
      // The duty.write △ (4.4): a Viewer may only propose a
      // change that starts from an assignment they hold.
      if (auth.role === "Viewer" && a.personId !== auth.teacherId) {
        throw new AuthAccessError(403, "権限がありません");
      }
      if (input.toPersonId) {
        await assertStaffMember(auth.schoolId, input.toPersonId);
      }
      return changeStore.proposeChange(
        db,
        auth.schoolId,
        {
          kind: input.kind,
          assignmentAId: input.assignmentAId,
          assignmentBId: input.assignmentBId ?? null,
          toPersonId: input.toPersonId ?? null,
          reason: input.reason,
        },
        auth.userId,
      );
    }),

    applyDutyChange: scheduleAction("duty.write", async ({ auth, request }) => {
      requireWriterRole(auth.role);
      const { id } = dutyChangeIdInputSchema.parse(request);
      return changeStore.applyChange(db, auth.schoolId, id, auth.userId);
    }),

    declineDutyChange: scheduleAction("duty.write", async ({ auth, request }) => {
      requireWriterRole(auth.role);
      const { id } = dutyChangeIdInputSchema.parse(request);
      return changeStore.declineChange(db, auth.schoolId, id, auth.userId);
    }),

    getDutyChanges: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getDutyChangesInputSchema.parse(request);
      return changeStore.listChanges(db, auth.schoolId, input.dutyDefinitionId);
    }),

    getDutyConflicts: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getDutyConflictsInputSchema.parse(request);
      if (!platform) {
        throw new Error("conflict derivation needs the platform source, which is not configured");
      }
      const range = { from: input.from, to: input.to };
      const [definitions, assignments, absences, waivers, absenceKinds] = await Promise.all([
        store.getDutyDefinitions(db, auth.schoolId),
        // A week assignment opening before the range still covers
        // its first days, so the read window opens a week early;
        // derivation expands it and keeps only in-range days.
        store.getAssignments(db, auth.schoolId, { from: addDays(input.from, -7), to: input.to }),
        platform.listAbsences(auth.schoolId, range),
        changeStore.listWaivers(db, auth.schoolId),
        changeStore.getConflictAbsenceKinds(db, auth.schoolId),
      ]);
      const expectedCells: DutyExpectedCell[] = [];
      for (const definition of definitions) {
        const factsOf = await factsFor(auth.schoolId, definition, range);
        const periodLike = {
          applicablePeriod: definition.applicablePeriod as DutyApplicablePeriod,
          startsOn: definition.applicableStartsOn,
          endsOn: definition.applicableEndsOn,
        };
        const applies = (date: string): boolean => dutyAppliesOn(periodLike, date, factsOf(date));
        if (definition.granularity === "day" || definition.granularity === "am_pm") {
          const slots = slotsForGranularity(definition.granularity as DutyGranularity);
          for (const date of datesInRange(input.from, input.to)) {
            if (!applies(date)) continue;
            for (const slot of slots) {
              expectedCells.push({ dutyDefinitionId: definition.id, date, slot });
            }
          }
        } else if (definition.granularity === "week") {
          const weekStart =
            (definition.rotation?.changeWeekdays?.[0] as Weekday | undefined) ?? "mon";
          for (
            let date = weekStartOf(input.from, weekStart);
            date <= input.to;
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
      const conflicts = deriveDutyConflicts({
        from: input.from,
        to: input.to,
        assignments: assignments.map(toAssignmentFact),
        absences,
        waivers,
        absenceKinds,
        expectedCells,
        dutyNames: Object.fromEntries(definitions.map((d) => [d.id, d.name])),
      });
      return input.dutyDefinitionId
        ? conflicts.filter((c) => c.dutyDefinitionId === input.dutyDefinitionId)
        : conflicts;
    }),

    waiveConflict: scheduleAction("duty.write", async ({ auth, request }) => {
      requireWriterRole(auth.role);
      const input = waiveConflictInputSchema.parse(request);
      return changeStore.waiveConflict(db, auth.schoolId, input, auth.userId);
    }),

    getDutyChangeCandidates: scheduleAction("duty.write", async ({ auth, request }) => {
      const input = getDutyChangeCandidatesInputSchema.parse(request);
      const a = await changeStore.getAssignmentById(db, auth.schoolId, input.assignmentId);
      if (!a) {
        throw new Error(`duty assignment not found: ${input.assignmentId}`);
      }
      if (auth.role === "Viewer" && a.personId !== auth.teacherId) {
        throw new AuthAccessError(403, "権限がありません");
      }
      if (!platform) {
        throw new Error("candidates need the platform source, which is not configured");
      }
      const definition = await loadDefinition(auth.schoolId, a.dutyDefinitionId);
      // "Near in the rotation order" needs an order: the duty's
      // rotation roster, or — for a duty without one — the staff
      // list in the platform's display order.
      const roster =
        definition.rotation && definition.rotation.personIds.length > 0
          ? definition.rotation.personIds
          : (await platform.listStaff(auth.schoolId)).filter((s) => s.active).map((s) => s.id);
      const dates = a.slot === "week" ? datesInRange(a.date, addDays(a.date, 6)) : [a.date];
      const [absences, assignments] = await Promise.all([
        platform.listAbsences(auth.schoolId, { from: a.date, to: addDays(a.date, 6) }),
        store.getAssignments(db, auth.schoolId, {
          from: addDays(a.date, -7),
          to: addDays(a.date, 6),
        }),
      ]);
      return rankDutyCandidates({
        roster,
        currentPersonId: a.personId,
        dates,
        slot: a.slot,
        absences,
        assignments: assignments.map(toAssignmentFact),
      });
    }),
  });
}

/** A stored assignment as conflict derivation / candidate ranking
 *  reads it (the origin string the database holds is the shared
 *  enum by check constraint). */
function toAssignmentFact(row: DutyAssignmentRow): DutyAssignmentFact {
  return {
    id: row.id,
    dutyDefinitionId: row.dutyDefinitionId,
    date: row.date,
    slot: row.slot,
    personId: row.personId,
    origin: row.origin as DutyOrigin,
  };
}
