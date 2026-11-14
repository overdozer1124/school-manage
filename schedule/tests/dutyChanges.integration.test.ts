import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import * as changeStore from "../src/db/dutyChanges.js";
import { dutyAssignments } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createDutyActions } from "../src/duties/actions.js";
import { and, eq } from "drizzle-orm";
import type {
  DutyAbsenceEntry,
  DutyPlatformSource,
  DutyStaffEntry,
} from "../src/duties/platformSource.js";

// Duty change / conflict tests (Issue #31): a swap lands on both
// assignments or neither, a substitute touches only its occasion,
// a Viewer proposes only for their own assignment, conflicts are
// derived from the platform's absences of the moment (a morning
// absence does not meet an afternoon duty; a tentative absence
// counts and says so), a waiver silences one pair without erasing
// the record, and candidates come out nearest-first in the
// rotation. The platform is a fake source whose absence list the
// tests rewrite as absences come and go.
const url = process.env.SCHEDULE_DATABASE_URL;

type DutyActions = ReturnType<typeof createDutyActions>;

function auth(schoolId: string, role: Role, teacherId: string | null = null): AuthContext {
  return {
    userId: `user-${schoolId}-${role}`,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId,
  };
}

const A = "school-a";
const B = "school-b";

const staffBySchool: Record<string, DutyStaffEntry[]> = {
  [A]: [
    { id: "teacher-a1", active: true },
    { id: "teacher-a2", active: true },
    { id: "teacher-a3", active: true },
    { id: "teacher-a4", active: true },
  ],
  [B]: [{ id: "teacher-b1", active: true }],
};

const absencesBySchool: Record<string, DutyAbsenceEntry[]> = { [A]: [], [B]: [] };

const fakePlatform: DutyPlatformSource = {
  async listStaff(schoolId) {
    return staffBySchool[schoolId] ?? [];
  },
  async listCalendarDays() {
    return [];
  },
  async listTerms() {
    return [];
  },
  async listAbsences(schoolId, range) {
    return (absencesBySchool[schoolId] ?? []).filter(
      (a) => a.fromDate <= range.to && a.toDate >= range.from,
    );
  },
};

function absence(o: Partial<DutyAbsenceEntry> & { id: string }): DutyAbsenceEntry {
  return {
    staffId: "teacher-a1",
    kind: "business_trip",
    certainty: "confirmed",
    fromDate: "2026-05-11",
    toDate: "2026-05-11",
    time: { kind: "all_day" },
    ...o,
  };
}

describe.skipIf(!url)("schedule duty changes and conflicts", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: Db;
  let duties: DutyActions;
  let definitions: ReturnType<typeof createDefinitionActions>;

  const adminA = auth(A, "Admin");
  const editorA = auth(A, "Editor");

  async function assignmentsOn(date: string) {
    return duties.getDutyAssignments.run(adminA, { from: date, to: date });
  }

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    duties = createDutyActions(db, fakePlatform);
    definitions = createDefinitionActions(db);

    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
    });
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-ampm",
      name: "日番",
      granularity: "am_pm",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2", "teacher-a3", "teacher-a4"] },
    });
    // April assignments for the change tests.
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-04-06",
      slot: "all_day",
      personId: "teacher-a1",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-04-07",
      slot: "all_day",
      personId: "teacher-a2",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-04-06",
      slot: "am",
      personId: "teacher-a2",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-04-06",
      slot: "pm",
      personId: "teacher-a3",
    });
    // May assignments for the conflict / candidate tests.
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-05-11",
      slot: "all_day",
      personId: "teacher-a1",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-05-11",
      slot: "am",
      personId: "teacher-a2",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-05-11",
      slot: "pm",
      personId: "teacher-a3",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-05-12",
      slot: "all_day",
      personId: "teacher-a2",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-05-12",
      slot: "am",
      personId: "teacher-a2",
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("a swap proposed by the holder and applied by an editor exchanges both sides", async () => {
    const dayA = (await assignmentsOn("2026-04-06")).find((r) => r.dutyDefinitionId === "duty-day");
    const dayB = (await assignmentsOn("2026-04-07")).find((r) => r.dutyDefinitionId === "duty-day");
    expect(dayA?.personId).toBe("teacher-a1");
    expect(dayB?.personId).toBe("teacher-a2");

    const viewerA1 = auth(A, "Viewer", "teacher-a1");
    const proposed = await duties.proposeDutyChange.run(viewerA1, {
      kind: "swap",
      assignmentAId: dayA?.id,
      assignmentBId: dayB?.id,
      reason: "出張のため",
    });
    expect(proposed).toMatchObject({
      kind: "swap",
      status: "proposed",
      fromPersonId: "teacher-a1",
      toPersonId: "teacher-a2",
      requestedBy: viewerA1.userId,
      approvedBy: null,
    });

    const applied = await duties.applyDutyChange.run(editorA, { id: proposed.id });
    expect(applied.status).toBe("applied");
    expect(applied.approvedBy).toBe(editorA.userId);
    expect(applied.appliedAt).not.toBeNull();

    const after6 = (await assignmentsOn("2026-04-06")).find(
      (r) => r.dutyDefinitionId === "duty-day",
    );
    const after7 = (await assignmentsOn("2026-04-07")).find(
      (r) => r.dutyDefinitionId === "duty-day",
    );
    expect(after6?.personId).toBe("teacher-a2");
    expect(after7?.personId).toBe("teacher-a1");
    expect(after6?.origin).toBe("swap");
    expect(after7?.origin).toBe("swap");

    const history = await duties.getDutyChanges.run(adminA, {
      dutyDefinitionId: "duty-day",
    });
    expect(history.map((c) => c.id)).toContain(proposed.id);
  });

  it("a swap whose partner has vanished applies to neither side", async () => {
    const rows = await assignmentsOn("2026-04-06");
    const dayA = rows.find((r) => r.dutyDefinitionId === "duty-day");
    const rows7 = await assignmentsOn("2026-04-07");
    const dayB = rows7.find((r) => r.dutyDefinitionId === "duty-day");
    // dayA now holds teacher-a2 (after the swap above), dayB teacher-a1.
    const proposed = await duties.proposeDutyChange.run(editorA, {
      kind: "swap",
      assignmentAId: dayA?.id,
      assignmentBId: dayB?.id,
    });
    await db
      .delete(dutyAssignments)
      .where(and(eq(dutyAssignments.schoolId, A), eq(dutyAssignments.id, dayB?.id as string)));
    await expect(duties.applyDutyChange.run(editorA, { id: proposed.id })).rejects.toThrow(
      "not found",
    );
    const after = (await assignmentsOn("2026-04-06")).find(
      (r) => r.dutyDefinitionId === "duty-day",
    );
    expect(after?.personId).toBe("teacher-a2");
    expect(after?.origin).toBe("swap");
    const change = (await duties.getDutyChanges.run(adminA, {})).find((c) => c.id === proposed.id);
    expect(change?.status).toBe("proposed");
    // Restore the deleted assignment for the tests below.
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-04-07",
      slot: "all_day",
      personId: "teacher-a1",
    });
  });

  it("a substitute changes only its occasion; a decline changes nothing", async () => {
    const rows = await assignmentsOn("2026-04-06");
    const pm = rows.find((r) => r.dutyDefinitionId === "duty-ampm" && r.slot === "pm");
    const proposed = await duties.proposeDutyChange.run(editorA, {
      kind: "substitute",
      assignmentAId: pm?.id,
      toPersonId: "teacher-a4",
      reason: "研修のため",
    });
    expect(proposed).toMatchObject({
      fromPersonId: "teacher-a3",
      toPersonId: "teacher-a4",
      status: "proposed",
    });
    await duties.applyDutyChange.run(editorA, { id: proposed.id });
    const after = await assignmentsOn("2026-04-06");
    expect(after.find((r) => r.id === pm?.id)?.personId).toBe("teacher-a4");
    expect(after.find((r) => r.id === pm?.id)?.origin).toBe("swap");
    // The morning of the same day and the original holder's other
    // occasions are untouched.
    expect(after.find((r) => r.dutyDefinitionId === "duty-ampm" && r.slot === "am")?.personId).toBe(
      "teacher-a2",
    );

    const declined = await duties.proposeDutyChange.run(editorA, {
      kind: "reassign",
      assignmentAId: pm?.id,
      toPersonId: "teacher-a1",
    });
    // A Viewer cannot decide, even about their own proposal flow.
    await expect(
      duties.applyDutyChange.run(auth(A, "Viewer", "teacher-a4"), { id: declined.id }),
    ).rejects.toMatchObject({ status: 403 });
    const decided = await duties.declineDutyChange.run(editorA, { id: declined.id });
    expect(decided.status).toBe("declined");
    expect(decided.approvedBy).toBe(editorA.userId);
    expect((await assignmentsOn("2026-04-06")).find((r) => r.id === pm?.id)?.personId).toBe(
      "teacher-a4",
    );
  });

  it("a Viewer cannot propose a change to someone else's assignment", async () => {
    const rows = await assignmentsOn("2026-04-07");
    const others = rows.find((r) => r.dutyDefinitionId === "duty-day");
    expect(others?.personId).toBe("teacher-a1");
    await expect(
      duties.proposeDutyChange.run(auth(A, "Viewer", "teacher-a2"), {
        kind: "substitute",
        assignmentAId: others?.id,
        toPersonId: "teacher-a2",
      }),
    ).rejects.toMatchObject({ status: 403 });
    // A Viewer with no staff link cannot propose at all.
    await expect(
      duties.proposeDutyChange.run(auth(A, "Viewer"), {
        kind: "substitute",
        assignmentAId: others?.id,
        toPersonId: "teacher-a2",
      }),
    ).rejects.toMatchObject({ status: 403 });
    // An editor proposing the same change is fine.
    const ok = await duties.proposeDutyChange.run(editorA, {
      kind: "substitute",
      assignmentAId: others?.id,
      toPersonId: "teacher-a2",
    });
    expect(ok.status).toBe("proposed");
    await duties.declineDutyChange.run(editorA, { id: ok.id });
  });

  it("derives absence conflicts, sparing the other half of the day", async () => {
    const day = "2026-05-11";
    // teacher-a3 is away in the morning only; their duty is the afternoon.
    absencesBySchool[A] = [
      absence({ id: "abs-a3-am", staffId: "teacher-a3", time: { kind: "half_day", half: "am" } }),
    ];
    let conflicts = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    expect(conflicts.filter((c) => c.kind === "absence")).toEqual([]);

    // The same absence in the afternoon meets the afternoon duty.
    absencesBySchool[A] = [
      absence({ id: "abs-a3-pm", staffId: "teacher-a3", time: { kind: "half_day", half: "pm" } }),
    ];
    conflicts = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    const pmConflicts = conflicts.filter((c) => c.kind === "absence");
    expect(pmConflicts).toHaveLength(1);
    expect(pmConflicts[0]).toMatchObject({
      dutyDefinitionId: "duty-ampm",
      slot: "pm",
      personId: "teacher-a3",
      absenceId: "abs-a3-pm",
      absenceKind: "business_trip",
      certainty: "confirmed",
    });
  });

  it("a tentative absence conflicts too, and reads as tentative", async () => {
    const day = "2026-05-11";
    absencesBySchool[A] = [
      absence({ id: "abs-a1-leave", staffId: "teacher-a1", kind: "leave", certainty: "tentative" }),
    ];
    const conflicts = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    const leave = conflicts.filter((c) => c.kind === "absence");
    expect(leave).toHaveLength(1);
    expect(leave[0]).toMatchObject({
      dutyDefinitionId: "duty-day",
      absenceId: "abs-a1-leave",
      absenceKind: "leave",
      certainty: "tentative",
    });
  });

  it("derives doubles and unassigned cells", async () => {
    absencesBySchool[A] = [];
    const doubles = await duties.getDutyConflicts.run(editorA, {
      from: "2026-05-12",
      to: "2026-05-12",
    });
    const dbl = doubles.filter((c) => c.kind === "double");
    expect(dbl).toHaveLength(1);
    expect(dbl[0]?.personId).toBe("teacher-a2");

    const gaps = await duties.getDutyConflicts.run(editorA, {
      from: "2026-05-13",
      to: "2026-05-13",
      dutyDefinitionId: "duty-day",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      kind: "unassigned",
      dutyDefinitionId: "duty-day",
      date: "2026-05-13",
      slot: "all_day",
      personId: null,
    });
  });

  it("a waiver silences one pair; the record stays after the absence goes", async () => {
    const day = "2026-05-11";
    const leave = absence({
      id: "abs-a1-leave",
      staffId: "teacher-a1",
      kind: "leave",
      certainty: "tentative",
    });
    absencesBySchool[A] = [leave];
    const before = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    const target = before.find((c) => c.kind === "absence");
    expect(target?.absenceId).toBe("abs-a1-leave");

    // A Viewer cannot waive.
    await expect(
      duties.waiveConflict.run(auth(A, "Viewer", "teacher-a1"), {
        assignmentId: target?.assignmentId as string,
        absenceId: "abs-a1-leave",
        reason: "本人が両立できると確認",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const waiver = await duties.waiveConflict.run(editorA, {
      assignmentId: target?.assignmentId as string,
      absenceId: "abs-a1-leave",
      reason: "本人が両立できると確認",
    });
    expect(waiver.waivedBy).toBe(editorA.userId);
    const after = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    expect(after.filter((c) => c.kind === "absence")).toEqual([]);

    // The absence disappears: the conflict stays gone (it was
    // derived), and the waiver record remains.
    absencesBySchool[A] = [];
    const gone = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    expect(gone.filter((c) => c.kind === "absence")).toEqual([]);
    const waivers = await changeStore.listWaivers(db, A);
    expect(waivers).toHaveLength(1);
    expect(waivers[0]).toMatchObject({
      absenceId: "abs-a1-leave",
      reason: "本人が両立できると確認",
    });
  });

  it("the school's setting decides which absence kinds count", async () => {
    const day = "2026-05-11";
    absencesBySchool[A] = [
      absence({ id: "abs-a1-leave", staffId: "teacher-a1", kind: "leave" }),
      absence({ id: "abs-a3-trip", staffId: "teacher-a3", time: { kind: "half_day", half: "pm" } }),
    ];
    await definitions.saveSettings.run(adminA, {
      inputOpener: "popover",
      dutyConflictAbsenceKinds: ["business_trip"],
    });
    let conflicts = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    // a1's leave no longer counts (and its earlier waiver is
    // irrelevant now); a3's trip still does.
    expect(conflicts.filter((c) => c.kind === "absence").map((c) => c.absenceId)).toEqual([
      "abs-a3-trip",
    ]);
    // Clearing the setting counts every kind again — except the
    // waived leave pair, which stays waived.
    await definitions.saveSettings.run(adminA, {
      inputOpener: "popover",
      dutyConflictAbsenceKinds: null,
    });
    conflicts = await duties.getDutyConflicts.run(editorA, { from: day, to: day });
    expect(conflicts.filter((c) => c.kind === "absence").map((c) => c.absenceId)).toEqual([
      "abs-a3-trip",
    ]);
    absencesBySchool[A] = [];
  });

  it("candidates are nearest in the rotation, skipping the absent and the busy", async () => {
    // 2026-05-11 pm (teacher-a3), rotation order a1→a2→a3→a4, so
    // nearest first is a4, a1, a2. a4 is away all day; a1 holds
    // the all-day duty, which overlaps the afternoon; a2 holds
    // only the morning, which does not — a2 alone can take it.
    absencesBySchool[A] = [absence({ id: "abs-a4", staffId: "teacher-a4", kind: "leave" })];
    const rows = await assignmentsOn("2026-05-11");
    const pm = rows.find((r) => r.dutyDefinitionId === "duty-ampm" && r.slot === "pm");
    const candidates = await duties.getDutyChangeCandidates.run(editorA, {
      assignmentId: pm?.id as string,
    });
    expect(candidates).toEqual(["teacher-a2"]);

    // The day duty (teacher-a1, all day): a2 and a3 are busy in
    // halves of that day, a4 is away — nobody can take it.
    const dayDuty = rows.find((r) => r.dutyDefinitionId === "duty-day");
    const none = await duties.getDutyChangeCandidates.run(editorA, {
      assignmentId: dayDuty?.id as string,
    });
    expect(none).toEqual([]);
    absencesBySchool[A] = [];
  });

  it("keeps the two schools' changes and conflicts apart", async () => {
    const adminB = auth(B, "Admin");
    const editorB = auth(B, "Editor");
    await duties.upsertDutyDefinition.run(adminB, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
    });
    await duties.setDutyAssignment.run(editorB, {
      dutyDefinitionId: "duty-day",
      date: "2026-05-11",
      slot: "all_day",
      personId: "teacher-b1",
    });
    absencesBySchool[B] = [
      absence({
        id: "abs-b1",
        staffId: "teacher-b1",
        fromDate: "2026-05-11",
        toDate: "2026-05-11",
      }),
    ];
    const conflictsB = await duties.getDutyConflicts.run(editorB, {
      from: "2026-05-11",
      to: "2026-05-11",
    });
    expect(conflictsB.filter((c) => c.kind === "absence")).toHaveLength(1);
    expect(conflictsB[0]?.absenceId).toBe("abs-b1");
    const conflictsA = await duties.getDutyConflicts.run(editorA, {
      from: "2026-05-11",
      to: "2026-05-11",
    });
    expect(conflictsA.filter((c) => c.absenceId === "abs-b1")).toEqual([]);
    expect(await duties.getDutyChanges.run(adminB, {})).toEqual([]);
    absencesBySchool[B] = [];
  });

  it("two editors applying the same swap at once land it only once", async () => {
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-06-08",
      slot: "all_day",
      personId: "teacher-a1",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-06-09",
      slot: "all_day",
      personId: "teacher-a2",
    });
    const dayA = (await assignmentsOn("2026-06-08")).find((r) => r.dutyDefinitionId === "duty-day");
    const dayB = (await assignmentsOn("2026-06-09")).find((r) => r.dutyDefinitionId === "duty-day");
    const proposed = await duties.proposeDutyChange.run(editorA, {
      kind: "swap",
      assignmentAId: dayA?.id,
      assignmentBId: dayB?.id,
    });

    // Two decisions race on separate connections: exactly one
    // applies, the other is refused as already decided — and the
    // holders end swapped once, not swapped back to the start.
    const second = createDb(url as string);
    try {
      const duties2 = createDutyActions(second.db, fakePlatform);
      const results = await Promise.allSettled([
        duties.applyDutyChange.run(editorA, { id: proposed.id }),
        duties2.applyDutyChange.run(editorA, { id: proposed.id }),
      ]);
      const settled = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(settled).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const reason = (refused[0] as PromiseRejectedResult).reason;
      expect(reason instanceof Error ? reason.message : String(reason)).toContain("not proposed");
    } finally {
      await second.queryClient.end();
    }

    expect(
      (await assignmentsOn("2026-06-08")).find((r) => r.dutyDefinitionId === "duty-day")?.personId,
    ).toBe("teacher-a2");
    expect(
      (await assignmentsOn("2026-06-09")).find((r) => r.dutyDefinitionId === "duty-day")?.personId,
    ).toBe("teacher-a1");
    const change = (await duties.getDutyChanges.run(adminA, {})).find((c) => c.id === proposed.id);
    expect(change?.status).toBe("applied");
  });

  it("a decided change refuses a second decision, either way", async () => {
    // Set the June 8 pm holder explicitly so this test stands alone.
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-06-08",
      slot: "pm",
      personId: "teacher-a3",
    });
    const pmRow = (await assignmentsOn("2026-06-08")).find(
      (r) => r.dutyDefinitionId === "duty-ampm" && r.slot === "pm",
    );
    expect(pmRow?.personId).toBe("teacher-a3");

    const applied = await duties.proposeDutyChange.run(editorA, {
      kind: "substitute",
      assignmentAId: pmRow?.id,
      toPersonId: "teacher-a4",
    });
    await duties.applyDutyChange.run(editorA, { id: applied.id });
    // A second apply and a late decline are both refused, and the
    // one landed decision is what stands.
    await expect(duties.applyDutyChange.run(editorA, { id: applied.id })).rejects.toThrow(
      "not proposed",
    );
    await expect(duties.declineDutyChange.run(editorA, { id: applied.id })).rejects.toThrow(
      "not proposed",
    );
    expect((await assignmentsOn("2026-06-08")).find((r) => r.id === pmRow?.id)?.personId).toBe(
      "teacher-a4",
    );

    const declined = await duties.proposeDutyChange.run(editorA, {
      kind: "substitute",
      assignmentAId: pmRow?.id,
      toPersonId: "teacher-a1",
    });
    await duties.declineDutyChange.run(editorA, { id: declined.id });
    await expect(duties.applyDutyChange.run(editorA, { id: declined.id })).rejects.toThrow(
      "not proposed",
    );
    expect((await assignmentsOn("2026-06-08")).find((r) => r.id === pmRow?.id)?.personId).toBe(
      "teacher-a4",
    );
  });

  it("a substitute records the holder who actually stood aside at apply time", async () => {
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-06-10",
      slot: "pm",
      personId: "teacher-a3",
    });
    const pm = (await assignmentsOn("2026-06-10")).find(
      (r) => r.dutyDefinitionId === "duty-ampm" && r.slot === "pm",
    );
    const proposed = await duties.proposeDutyChange.run(editorA, {
      kind: "substitute",
      assignmentAId: pm?.id,
      toPersonId: "teacher-a4",
    });
    // The proposal names the holder of the moment.
    expect(proposed.fromPersonId).toBe("teacher-a3");
    // The holder changes before the decision lands.
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-ampm",
      date: "2026-06-10",
      slot: "pm",
      personId: "teacher-a1",
    });
    const applied = await duties.applyDutyChange.run(editorA, { id: proposed.id });
    // The record says who actually stood aside, not who held the
    // duty when the change was proposed.
    expect(applied.fromPersonId).toBe("teacher-a1");
    expect(applied.toPersonId).toBe("teacher-a4");
    expect((await assignmentsOn("2026-06-10")).find((r) => r.id === pm?.id)?.personId).toBe(
      "teacher-a4",
    );
  });
});
