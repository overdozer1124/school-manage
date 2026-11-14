import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { resolveDayFacts } from "@school-manage/calendar-types";
import { createDb, type Db } from "../src/db/client.js";
import * as dutyStore from "../src/db/duties.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createDutyActions } from "../src/duties/actions.js";
import type {
  DutyCalendarDay,
  DutyPlatformSource,
  DutyStaffEntry,
} from "../src/duties/platformSource.js";
import { createViewActions } from "../src/views/actions.js";

// Duty tests (Issue #30): DESIGN 5.2 scenarios 3 and 4, the
// preview/apply contract (a preview saves nothing, applying never
// overwrites a manual assignment), the staff-roster check against
// the platform (another school's teacher cannot enter a rotation),
// and two-school isolation throughout. The platform is a fake
// source: school A is on summer vacation 2026-07-21..08-31 (the
// platform records those days as long_vacation) and its terms are
// 04-01..07-20 and 09-01..12-25.
const url = process.env.SCHEDULE_DATABASE_URL;

type DutyActions = ReturnType<typeof createDutyActions>;

function auth(schoolId: string, role: Role): AuthContext {
  return {
    userId: `user-${schoolId}`,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
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
  [B]: [
    { id: "teacher-b1", active: true },
    { id: "teacher-b2", active: true },
  ],
};

const fakePlatform: DutyPlatformSource = {
  async listStaff(schoolId) {
    return staffBySchool[schoolId] ?? [];
  },
  async listCalendarDays(schoolId, range) {
    if (schoolId !== A) return [];
    const days: DutyCalendarDay[] = [];
    for (let d = "2026-07-21"; d <= "2026-08-31" && d <= range.to; d = nextDay(d)) {
      if (d >= range.from) days.push({ date: d, dayType: "long_vacation" });
    }
    return days;
  },
  async listAbsences() {
    return [];
  },
  async listTerms(schoolId) {
    if (schoolId !== A) return [];
    return [
      { startsOn: "2026-04-01", endsOn: "2026-07-20" },
      { startsOn: "2026-09-01", endsOn: "2026-12-25" },
    ];
  },
};

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

describe.skipIf(!url)("schedule duties", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: Db;
  let duties: DutyActions;
  let dutiesNoPlatform: DutyActions;
  let definitions: ReturnType<typeof createDefinitionActions>;
  let views: ReturnType<typeof createViewActions>;

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
    dutiesNoPlatform = createDutyActions(db);
    definitions = createDefinitionActions(db);
    views = createViewActions(db);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("scenario 3: a school has zero, one (day), or two (day + week) duty definitions", async () => {
    const adminA = auth(A, "Admin");
    expect(await duties.getDutyDefinitions.run(adminA, null)).toEqual([]);

    const day = await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-nichoku",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
    });
    expect(day.rotation).toBeNull();
    expect((await duties.getDutyDefinitions.run(adminA, null)).map((d) => d.id)).toEqual([
      "duty-nichoku",
    ]);

    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-shuban",
      name: "週番",
      granularity: "week",
      applicablePeriod: "all_year",
      sort: 2,
    });
    expect((await duties.getDutyDefinitions.run(adminA, null)).map((d) => d.id)).toEqual([
      "duty-nichoku",
      "duty-shuban",
    ]);

    // School B is untouched by A's definitions, and may reuse ids.
    expect(await duties.getDutyDefinitions.run(auth(B, "Admin"), null)).toEqual([]);
    await duties.upsertDutyDefinition.run(auth(B, "Admin"), {
      id: "duty-nichoku",
      name: "日直B",
      granularity: "day",
      applicablePeriod: "all_year",
    });
    expect(
      (await duties.getDutyDefinitions.run(auth(B, "Admin"), null)).map((d) => d.name),
    ).toEqual(["日直B"]);
    expect((await duties.getDutyDefinitions.run(adminA, null)).map((d) => d.name)).toEqual([
      "日直",
      "週番",
    ]);
  });

  it("scenario 4: a long-vacation-only am/pm duty generates only on vacation days, am and pm apart", async () => {
    const adminA = auth(A, "Admin");
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-summer",
      name: "夏休み日直",
      granularity: "am_pm",
      applicablePeriod: "long_vacation_only",
      rotation: { personIds: ["teacher-a1", "teacher-a2", "teacher-a3"] },
    });

    // 07-20 is still term time; the vacation starts 07-21.
    const plan = await duties.previewRotation.run(adminA, {
      dutyDefinitionId: "duty-summer",
      from: "2026-07-20",
      to: "2026-07-22",
    });
    expect(plan.map((c) => `${c.date} ${c.slot} ${c.personId}`)).toEqual([
      "2026-07-21 am teacher-a1",
      "2026-07-21 pm teacher-a2",
      "2026-07-22 am teacher-a3",
      "2026-07-22 pm teacher-a1",
    ]);
    expect(plan.every((c) => c.action === "create")).toBe(true);

    // A preview saves nothing.
    expect(
      await duties.getDutyAssignments.run(adminA, {
        dutyDefinitionId: "duty-summer",
        from: "2026-07-20",
        to: "2026-07-22",
      }),
    ).toEqual([]);

    const applied = await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-summer",
      from: "2026-07-20",
      to: "2026-07-22",
    });
    expect(applied).toMatchObject({ created: 4, updated: 0, skipped: 0 });
    const saved = await duties.getDutyAssignments.run(adminA, {
      dutyDefinitionId: "duty-summer",
      from: "2026-07-20",
      to: "2026-07-22",
    });
    expect(saved.map((a) => `${a.date} ${a.slot} ${a.personId} ${a.origin}`)).toEqual([
      "2026-07-21 am teacher-a1 auto",
      "2026-07-21 pm teacher-a2 auto",
      "2026-07-22 am teacher-a3 auto",
      "2026-07-22 pm teacher-a1 auto",
    ]);
    // School B sees none of A's assignments.
    expect(
      await duties.getDutyAssignments.run(auth(B, "Admin"), {
        from: "2026-07-20",
        to: "2026-07-22",
      }),
    ).toEqual([]);
  });

  it("a term duty generates inside terms only, and a week duty starts its weeks on the changeover day", async () => {
    const adminA = auth(A, "Admin");
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-term",
      name: "学期の日番",
      granularity: "day",
      applicablePeriod: "term",
      rotation: { personIds: ["teacher-a1", "teacher-a2"] },
    });
    const termPlan = await duties.previewRotation.run(adminA, {
      dutyDefinitionId: "duty-term",
      from: "2026-07-19",
      to: "2026-07-21",
    });
    expect(termPlan.map((c) => c.date)).toEqual(["2026-07-19", "2026-07-20"]);

    // 週番の金曜交代: the week runs Friday to Thursday.
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-week-fri",
      name: "週番（金曜交代）",
      granularity: "week",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"], changeWeekdays: ["fri"] },
    });
    const applied = await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-week-fri",
      from: "2026-04-06",
      to: "2026-04-19",
    });
    expect(applied.assignments.map((a) => `${a.date} ${a.slot} ${a.personId}`)).toEqual([
      "2026-04-03 week teacher-a1",
      "2026-04-10 week teacher-a2",
      "2026-04-17 week teacher-a1",
    ]);
  });

  it("a week duty applied in two chunks starting mid-week continues cleanly", async () => {
    const adminA = auth(A, "Admin");
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-week-split",
      name: "週番（分割適用）",
      granularity: "week",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"], changeWeekdays: ["fri"] },
    });
    // The range starts on a Monday, but the Friday-changeover
    // weeks start earlier (04-03). Applying in two chunks must
    // neither collide with the earlier chunk's week rows nor
    // shift the rotation.
    const first = await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-week-split",
      from: "2026-04-06",
      to: "2026-04-19",
    });
    expect(first).toMatchObject({ created: 3, updated: 0, skipped: 0 });
    const second = await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-week-split",
      from: "2026-04-20",
      to: "2026-05-03",
    });
    expect(second).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    const rows = await duties.getDutyAssignments.run(adminA, {
      dutyDefinitionId: "duty-week-split",
      from: "2026-04-01",
      to: "2026-05-03",
    });
    expect(rows.map((a) => `${a.date} ${a.personId} ${a.origin}`)).toEqual([
      "2026-04-03 teacher-a1 auto",
      "2026-04-10 teacher-a2 auto",
      "2026-04-17 teacher-a1 auto",
      "2026-04-24 teacher-a2 auto",
      "2026-05-01 teacher-a1 auto",
    ]);
  });

  it("applying the same week range twice keeps every cell the second time", async () => {
    const adminA = auth(A, "Admin");
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-week-twice",
      name: "週番（再適用）",
      granularity: "week",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"], changeWeekdays: ["fri"] },
    });
    const first = await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-week-twice",
      from: "2026-04-06",
      to: "2026-04-19",
    });
    expect(first).toMatchObject({ created: 3, updated: 0, skipped: 0 });
    const second = await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-week-twice",
      from: "2026-04-06",
      to: "2026-04-19",
    });
    expect(second).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    const rows = await duties.getDutyAssignments.run(adminA, {
      dutyDefinitionId: "duty-week-twice",
      from: "2026-04-01",
      to: "2026-04-19",
    });
    expect(rows.map((a) => `${a.date} ${a.personId}`)).toEqual([
      "2026-04-03 teacher-a1",
      "2026-04-10 teacher-a2",
      "2026-04-17 teacher-a1",
    ]);
  });

  it("applying never overwrites a manual assignment; a manual set over an auto row is an override", async () => {
    const editorA = auth(A, "Editor");
    await duties.upsertDutyDefinition.run(auth(A, "Admin"), {
      id: "duty-manual",
      name: "手動テスト日番",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"] },
    });
    const manual = await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-manual",
      date: "2026-04-06",
      slot: "all_day",
      personId: "teacher-a3",
    });
    expect(manual).toMatchObject({ origin: "manual", isManualOverride: false });

    const plan = await duties.previewRotation.run(editorA, {
      dutyDefinitionId: "duty-manual",
      from: "2026-04-06",
      to: "2026-04-07",
    });
    expect(plan.map((c) => `${c.date} ${c.action}`)).toEqual([
      "2026-04-06 keep",
      "2026-04-07 create",
    ]);

    const applied = await duties.applyRotation.run(editorA, {
      dutyDefinitionId: "duty-manual",
      from: "2026-04-06",
      to: "2026-04-07",
    });
    expect(applied).toMatchObject({ created: 1, updated: 0, skipped: 1 });
    const rows = await duties.getDutyAssignments.run(editorA, {
      dutyDefinitionId: "duty-manual",
      from: "2026-04-06",
      to: "2026-04-07",
    });
    expect(rows.map((a) => `${a.date} ${a.personId} ${a.origin}`)).toEqual([
      "2026-04-06 teacher-a3 manual",
      "2026-04-07 teacher-a2 auto",
    ]);

    // Setting the auto cell by hand keeps the row and marks it.
    const overridden = await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-manual",
      date: "2026-04-07",
      slot: "all_day",
      personId: "teacher-a1",
    });
    expect(overridden).toMatchObject({
      id: rows[1]?.id,
      origin: "manual",
      isManualOverride: true,
      personId: "teacher-a1",
    });

    // Naming no holder empties the cell but leaves a manual row
    // with no holder, so the clearing itself is on record.
    const cleared = await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-manual",
      date: "2026-04-07",
      slot: "all_day",
    });
    expect(cleared).toMatchObject({
      id: rows[1]?.id,
      personId: null,
      targetId: null,
      origin: "manual",
      isManualOverride: true,
    });
    const afterClear = await duties.getDutyAssignments.run(editorA, {
      dutyDefinitionId: "duty-manual",
      from: "2026-04-07",
      to: "2026-04-07",
    });
    expect(afterClear.map((a) => `${a.date} ${a.personId} ${a.origin}`)).toEqual([
      "2026-04-07 null manual",
    ]);
  });

  it("a manually cleared cell is not refilled by the next rotation apply", async () => {
    const editorA = auth(A, "Editor");
    await duties.upsertDutyDefinition.run(auth(A, "Admin"), {
      id: "duty-clear",
      name: "クリアテスト",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"] },
    });
    await duties.applyRotation.run(editorA, {
      dutyDefinitionId: "duty-clear",
      from: "2026-04-06",
      to: "2026-04-07",
    });
    await duties.setDutyAssignment.run(editorA, {
      dutyDefinitionId: "duty-clear",
      date: "2026-04-07",
      slot: "all_day",
    });
    // The cleared cell is a manual row, so applying again keeps
    // both cells and creates nothing.
    const reapplied = await duties.applyRotation.run(editorA, {
      dutyDefinitionId: "duty-clear",
      from: "2026-04-06",
      to: "2026-04-07",
    });
    expect(reapplied).toMatchObject({ created: 0, updated: 0, skipped: 2 });
    const rows = await duties.getDutyAssignments.run(editorA, {
      dutyDefinitionId: "duty-clear",
      from: "2026-04-06",
      to: "2026-04-07",
    });
    expect(rows.map((a) => `${a.date} ${a.personId} ${a.origin}`)).toEqual([
      "2026-04-06 teacher-a1 auto",
      "2026-04-07 null manual",
    ]);
  });

  it("regenerating a later range continues the rotation instead of restarting it", async () => {
    const adminA = auth(A, "Admin");
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-continuity",
      name: "継続テスト",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2", "teacher-a3"] },
    });
    await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-continuity",
      from: "2026-05-01",
      to: "2026-05-02",
    });
    const plan = await duties.previewRotation.run(adminA, {
      dutyDefinitionId: "duty-continuity",
      from: "2026-05-03",
      to: "2026-05-04",
    });
    expect(plan.map((c) => c.personId)).toEqual(["teacher-a3", "teacher-a1"]);
  });

  it("refuses another school's teacher in a rotation and in a manual assignment", async () => {
    const adminA = auth(A, "Admin");
    await expect(
      duties.upsertDutyDefinition.run(adminA, {
        id: "duty-cross",
        name: "他校混入",
        granularity: "day",
        applicablePeriod: "all_year",
        rotation: { personIds: ["teacher-a1", "teacher-b1"] },
      }),
    ).rejects.toThrow(/not staff of this school/);
    // Nothing was written.
    expect(
      (await duties.getDutyDefinitions.run(adminA, null)).find((d) => d.id === "duty-cross"),
    ).toBeUndefined();

    await expect(
      duties.setDutyAssignment.run(auth(A, "Editor"), {
        dutyDefinitionId: "duty-nichoku",
        date: "2026-04-06",
        slot: "all_day",
        personId: "teacher-b1",
      }),
    ).rejects.toThrow(/not a staff member of this school/);
  });

  it("enforces the 4.4 roles: definitions are Admin-only, Viewer previews but cannot set or apply", async () => {
    const editorA = auth(A, "Editor");
    const viewerA = auth(A, "Viewer");
    await expect(
      duties.upsertDutyDefinition.run(editorA, {
        id: "duty-nope",
        name: "不可",
        granularity: "day",
        applicablePeriod: "all_year",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      duties.setDutyAssignment.run(viewerA, {
        dutyDefinitionId: "duty-nichoku",
        date: "2026-04-06",
        slot: "all_day",
        personId: "teacher-a1",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      duties.applyRotation.run(viewerA, {
        dutyDefinitionId: "duty-manual",
        from: "2026-04-06",
        to: "2026-04-07",
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Reading and previewing stay open to staff roles.
    await expect(
      duties.getDutyAssignments.run(viewerA, { from: "2026-04-06", to: "2026-04-07" }),
    ).resolves.toBeDefined();
    await expect(
      duties.previewRotation.run(viewerA, {
        dutyDefinitionId: "duty-manual",
        from: "2026-04-06",
        to: "2026-04-07",
      }),
    ).resolves.toBeDefined();
  });

  it("a students' duty takes targets of its axis, not people", async () => {
    const adminA = auth(A, "Admin");
    await definitions.upsertTargetGroup.run(adminA, {
      id: "tg-class-duty",
      key: "class_duty",
      name: "学級",
    });
    await definitions.upsertTarget.run(adminA, {
      id: "tgt-1-1",
      targetGroupId: "tg-class-duty",
      name: "1年1組",
    });
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-cleaning",
      name: "清掃当番",
      granularity: "day",
      applicablePeriod: "all_year",
      targetGroupId: "tg-class-duty",
    });
    const row = await duties.setDutyAssignment.run(auth(A, "Editor"), {
      dutyDefinitionId: "duty-cleaning",
      date: "2026-04-06",
      slot: "all_day",
      targetId: "tgt-1-1",
    });
    expect(row).toMatchObject({ targetId: "tgt-1-1", personId: null });
    await expect(
      duties.setDutyAssignment.run(auth(A, "Editor"), {
        dutyDefinitionId: "duty-cleaning",
        date: "2026-04-07",
        slot: "all_day",
        personId: "teacher-a1",
      }),
    ).rejects.toThrow(/takes a target, not a person/);
    await expect(
      duties.setDutyAssignment.run(auth(A, "Editor"), {
        dutyDefinitionId: "duty-cleaning",
        date: "2026-04-07",
        slot: "all_day",
        targetId: "tgt-1-1-b",
      }),
    ).rejects.toThrow(/not owned by school/);
  });

  it("a duty definition used by a view cannot be deleted; deleting it removes its assignments", async () => {
    const adminA = auth(A, "Admin");
    await views.upsertViewDefinition.run(adminA, {
      id: "view-with-duty",
      name: "当番列のあるビュー",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [{ id: "col-duty", sourceKind: "duty", dutyDefinitionId: "duty-summer", sort: 1 }],
    });
    await expect(duties.deleteDutyDefinition.run(adminA, { id: "duty-summer" })).rejects.toThrow(
      /used by a view/,
    );
    await views.deleteViewDefinition.run(adminA, { id: "view-with-duty" });
    await expect(duties.deleteDutyDefinition.run(adminA, { id: "duty-summer" })).resolves.toEqual({
      deleted: true,
    });
    expect(
      await duties.getDutyAssignments.run(adminA, {
        dutyDefinitionId: "duty-summer",
        from: "2026-07-20",
        to: "2026-07-22",
      }),
    ).toEqual([]);
  });

  it("without a platform source, calendar-free periods still work and the rest refuse with the reason", async () => {
    const adminA = auth(A, "Admin");
    await dutiesNoPlatform.upsertDutyDefinition.run(adminA, {
      id: "duty-custom",
      name: "期間限定",
      granularity: "day",
      applicablePeriod: "custom_range",
      applicableStartsOn: "2026-04-10",
      applicableEndsOn: "2026-04-11",
      rotation: undefined,
    });
    // A rotation cannot be validated without the staff roster.
    await expect(
      dutiesNoPlatform.upsertDutyDefinition.run(adminA, {
        id: "duty-custom",
        name: "期間限定",
        granularity: "day",
        applicablePeriod: "custom_range",
        applicableStartsOn: "2026-04-10",
        applicableEndsOn: "2026-04-11",
        rotation: { personIds: ["teacher-a1"] },
      }),
    ).rejects.toThrow(/not configured/);

    // The same definition with a roster, written through the
    // configured actions, previews over its custom range with no
    // platform calendar read (custom_range needs none).
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-custom",
      name: "期間限定",
      granularity: "day",
      applicablePeriod: "custom_range",
      applicableStartsOn: "2026-04-10",
      applicableEndsOn: "2026-04-11",
      rotation: { personIds: ["teacher-a1", "teacher-a2"] },
    });
    const plan = await dutiesNoPlatform.previewRotation.run(adminA, {
      dutyDefinitionId: "duty-custom",
      from: "2026-04-09",
      to: "2026-04-12",
    });
    expect(plan.map((c) => `${c.date} ${c.personId}`)).toEqual([
      "2026-04-10 teacher-a1",
      "2026-04-11 teacher-a2",
    ]);
    // But a long-vacation duty has no honest answer without the
    // platform calendar.
    await expect(
      dutiesNoPlatform.previewRotation.run(adminA, {
        dutyDefinitionId: "duty-term",
        from: "2026-07-19",
        to: "2026-07-21",
      }),
    ).rejects.toThrow(/needs the platform calendar/);
  });

  it("applying a stale plan leaves a manual assignment that landed after the preview", async () => {
    const adminA = auth(A, "Admin");
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-race",
      name: "競合テスト",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"] },
    });
    await duties.applyRotation.run(adminA, {
      dutyDefinitionId: "duty-race",
      from: "2026-06-01",
      to: "2026-06-02",
    });
    // Reversing the rotation makes both cells "replace" in a plan.
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-race",
      name: "競合テスト",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a2", "teacher-a1"] },
    });
    const definition = await dutyStore.getDutyDefinition(db, A, "duty-race");
    if (!definition) throw new Error("duty-race definition missing");
    const plan = await dutyStore.buildRotationPlan(db, A, {
      definition,
      range: { from: "2026-06-01", to: "2026-06-02" },
      slots: ["all_day"],
      factsOf: (date) => resolveDayFacts(date, undefined, []),
    });
    expect(plan.map((c) => c.action)).toEqual(["replace", "replace"]);

    // A manual set lands on one cell after the plan was made.
    await duties.setDutyAssignment.run(auth(A, "Editor"), {
      dutyDefinitionId: "duty-race",
      date: "2026-06-01",
      slot: "all_day",
      personId: "teacher-a3",
    });
    const result = await dutyStore.applyRotationPlan(db, A, "duty-race", plan, "user-school-a");
    expect(result).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    const rows = await duties.getDutyAssignments.run(adminA, {
      dutyDefinitionId: "duty-race",
      from: "2026-06-01",
      to: "2026-06-02",
    });
    expect(rows.map((a) => `${a.date} ${a.personId} ${a.origin}`)).toEqual([
      "2026-06-01 teacher-a3 manual",
      "2026-06-02 teacher-a1 auto",
    ]);
  });

  it("a duty definition cannot name both a target group and a rotation", async () => {
    const adminA = auth(A, "Admin");
    await definitions.upsertTargetGroup.run(adminA, {
      id: "tg-rotation-check",
      key: "rotation_check",
      name: "輪番不可チェック",
    });
    // Both in one save: refused, and nothing is written.
    await expect(
      duties.upsertDutyDefinition.run(adminA, {
        id: "duty-both",
        name: "両指定",
        granularity: "day",
        applicablePeriod: "all_year",
        targetGroupId: "tg-rotation-check",
        rotation: { personIds: ["teacher-a1", "teacher-a2"] },
      }),
    ).rejects.toThrow(/cannot have a rotation rule/);
    expect(
      (await duties.getDutyDefinitions.run(adminA, null)).find((d) => d.id === "duty-both"),
    ).toBeUndefined();

    // Adding a target group to a definition that already has a
    // rotation is refused too, and the definition is unchanged.
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-retain",
      name: "輪番保持",
      granularity: "day",
      applicablePeriod: "all_year",
      rotation: { personIds: ["teacher-a1", "teacher-a2"] },
    });
    await expect(
      duties.upsertDutyDefinition.run(adminA, {
        id: "duty-retain",
        name: "輪番保持",
        granularity: "day",
        applicablePeriod: "all_year",
        targetGroupId: "tg-rotation-check",
      }),
    ).rejects.toThrow(/cannot have a rotation rule/);
    const retained = (await duties.getDutyDefinitions.run(adminA, null)).find(
      (d) => d.id === "duty-retain",
    );
    expect(retained?.targetGroupId).toBeNull();
    expect(retained?.rotation?.personIds).toEqual(["teacher-a1", "teacher-a2"]);
  });
});
