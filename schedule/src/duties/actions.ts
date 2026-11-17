import { AuthAccessError, defineActions } from "@school-manage/platform-client";
import {
  addDays,
  datesInRange,
  isDutySlot,
  rankDutyCandidates,
  slotsForGranularity,
  type DutyGranularity,
} from "@school-manage/calendar-types";
import * as store from "../db/duties.js";
import * as changeStore from "../db/dutyChanges.js";
import { targetGroups, targets } from "../db/schema.js";
import { deriveDutyConflictsForRange, factsFor, toAssignmentFact } from "./conflicts.js";
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

  async function buildPlan(schoolId: string, input: RotationRangeInput) {
    const definition = await loadDefinition(schoolId, input.dutyDefinitionId);
    // A stopped duty (Issue #86) generates no new assignments:
    // neither the preview nor the apply runs for it.
    if (!definition.isActive) {
      throw new Error(`duty definition is not active: ${definition.id}`);
    }
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
    const factsOf = await factsFor(platform, schoolId, definition, range);
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
      // A stopped duty (Issue #86) takes no new assignment input.
      // Its standing assignments stay readable, and the change
      // flow (propose / apply) still works on them: those actions
      // rearrange records that already exist rather than writing
      // new assignments into the duty.
      if (!definition.isActive) {
        throw new Error(`duty definition is not active: ${definition.id}`);
      }
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
      // The derivation itself lives in one place (conflicts.ts,
      // Issue #69): getRange calls the same function, so the two
      // reads agree on the same range by construction.
      const conflicts = await deriveDutyConflictsForRange(db, platform, auth.schoolId, {
        from: input.from,
        to: input.to,
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
