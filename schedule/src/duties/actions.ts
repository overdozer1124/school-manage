import { AuthAccessError, defineActions } from "@school-manage/platform-client";
import {
  isDutySlot,
  resolveDayFacts,
  slotsForGranularity,
  type DutyDayFacts,
  type DutyGranularity,
} from "@school-manage/calendar-types";
import * as store from "../db/duties.js";
import { targetGroups, targets } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import type { DutyPlatformSource } from "./platformSource.js";
import {
  deleteDutyInputSchema,
  dutyDefinitionInputSchema,
  getDutyAssignmentsInputSchema,
  rotationRangeInputSchema,
  setDutyAssignmentInputSchema,
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
 * swap proposals only, which are the next issue. Swap proposals do
 * not exist yet, so in this issue a Viewer may preview a rotation
 * (which writes nothing) but setting and applying refuse them
 * here, per row, as 4.3 prescribes for △ permissions.
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
      const assignment = await store.setAssignment(
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
      return assignment ?? { deleted: true };
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
  });
}
