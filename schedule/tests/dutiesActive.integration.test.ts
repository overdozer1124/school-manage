import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDutyActions } from "../src/duties/actions.js";
import type {
  DutyAbsenceEntry,
  DutyPlatformSource,
  DutyStaffEntry,
} from "../src/duties/platformSource.js";

// Duty stop / resume tests (Issue #86): stopping a definition
// takes it out of rotation generation and new assignment input,
// but its standing assignments, change history and absence
// conflicts stay readable; resuming puts it back in use. The
// platform is a fake source whose absence list the tests rewrite.

const url = process.env.SCHEDULE_DATABASE_URL;

type DutyActions = ReturnType<typeof createDutyActions>;

function auth(schoolId: string, role: Role): AuthContext {
  return {
    userId: `user-${schoolId}-${role}`,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

const A = "school-a";

const staffBySchool: Record<string, DutyStaffEntry[]> = {
  [A]: [
    { id: "teacher-a1", active: true },
    { id: "teacher-a2", active: true },
    { id: "teacher-a3", active: true },
    { id: "teacher-a4", active: true },
  ],
};

const absencesBySchool: Record<string, DutyAbsenceEntry[]> = { [A]: [] };

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

describe.skipIf(!url)("schedule duty stop and resume (Issue #86)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: Db;
  let duties: DutyActions;

  const adminA = auth(A, "Admin");
  const editorA = auth(A, "Editor");

  async function definition() {
    const list = await duties.getDutyDefinitions.run(adminA, null);
    return list.find((d) => d.id === "duty-day");
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

    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2", "teacher-a3", "teacher-a4"] },
    });
    // One standing assignment, then a substitute change on it,
    // so the duty has history before it is stopped.
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-05-11",
      slot: "all_day",
      personId: "teacher-a1",
    });
    const [assignment] = await duties.getDutyAssignments.run(adminA, {
      from: "2026-05-11",
      to: "2026-05-11",
    });
    if (!assignment) throw new Error("the standing assignment was not written");
    const change = await duties.proposeDutyChange.run(editorA, {
      kind: "substitute",
      assignmentAId: assignment.id,
      toPersonId: "teacher-a2",
      reason: "出張のため",
    });
    await duties.applyDutyChange.run(editorA, { id: change.id });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("a new definition is active by default", async () => {
    expect((await definition())?.isActive).toBe(true);
  });

  it("while active, empty cells of the duty are unassigned conflicts", async () => {
    const conflicts = await duties.getDutyConflicts.run(adminA, {
      from: "2026-05-18",
      to: "2026-05-22",
    });
    expect(
      conflicts.filter((c) => c.dutyDefinitionId === "duty-day" && c.kind === "unassigned"),
    ).toHaveLength(5);
  });

  it("stopping the duty refuses rotation and new assignment input", async () => {
    const stopped = await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
      isActive: false,
    });
    expect(stopped.isActive).toBe(false);
    expect((await definition())?.isActive).toBe(false);

    await expect(
      duties.previewRotation.run(editorA, {
        dutyDefinitionId: "duty-day",
        from: "2026-05-18",
        to: "2026-05-22",
      }),
    ).rejects.toThrow("duty definition is not active");
    await expect(
      duties.applyRotation.run(editorA, {
        dutyDefinitionId: "duty-day",
        from: "2026-05-18",
        to: "2026-05-22",
      }),
    ).rejects.toThrow("duty definition is not active");
    await expect(
      duties.setDutyAssignment.run(editorA, {
        dutyDefinitionId: "duty-day",
        date: "2026-05-18",
        slot: "all_day",
        personId: "teacher-a3",
      }),
    ).rejects.toThrow("duty definition is not active");
    // Nothing was written for the fresh week.
    expect(
      await duties.getDutyAssignments.run(adminA, { from: "2026-05-18", to: "2026-05-22" }),
    ).toHaveLength(0);
  });

  it("stopping keeps the standing assignment and its change history readable", async () => {
    const rows = await duties.getDutyAssignments.run(adminA, {
      from: "2026-05-11",
      to: "2026-05-11",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.personId).toBe("teacher-a2");
    const changes = await duties.getDutyChanges.run(adminA, {});
    expect(changes).toHaveLength(1);
    expect(changes[0]?.status).toBe("applied");
  });

  it("stopping drops unassigned conflicts but keeps the absence conflict of a standing assignment", async () => {
    absencesBySchool[A] = [
      {
        id: "abs-1",
        staffId: "teacher-a2",
        kind: "business_trip",
        certainty: "confirmed",
        fromDate: "2026-05-11",
        toDate: "2026-05-11",
        time: { kind: "all_day" },
      },
    ];
    const conflicts = await duties.getDutyConflicts.run(adminA, {
      from: "2026-05-11",
      to: "2026-05-22",
    });
    const dutyConflicts = conflicts.filter((c) => c.dutyDefinitionId === "duty-day");
    expect(dutyConflicts.some((c) => c.kind === "absence" && c.date === "2026-05-11")).toBe(true);
    expect(dutyConflicts.some((c) => c.kind === "unassigned")).toBe(false);
  });

  it("resuming the duty puts it back in use", async () => {
    const resumed = await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
      isActive: true,
    });
    expect(resumed.isActive).toBe(true);

    const saved = await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-day",
      date: "2026-05-18",
      slot: "all_day",
      personId: "teacher-a3",
    });
    expect(saved.personId).toBe("teacher-a3");
    const applied = await duties.applyRotation.run(editorA, {
      dutyDefinitionId: "duty-day",
      from: "2026-05-19",
      to: "2026-05-22",
    });
    expect(applied.created).toBe(4);
    expect(
      await duties.getDutyAssignments.run(adminA, { from: "2026-05-18", to: "2026-05-22" }),
    ).toHaveLength(5);
  });
});
