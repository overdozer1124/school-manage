import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import {
  eventInRange,
  filterVisible,
  forAudience,
  type Audience,
} from "@school-manage/calendar-types";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createDailyValueActions } from "../src/dailyValues/actions.js";
import { createDutyActions } from "../src/duties/actions.js";
import type { DutyPlatformSource } from "../src/duties/platformSource.js";
import { createEventActions } from "../src/events/actions.js";
import { createRangeActions } from "../src/range/actions.js";
import { createViewActions } from "../src/views/actions.js";
import { createPlatformApiClient } from "../src/platformClient.js";

// Month notes tests (Issue #46): a view's monthly accompanying
// notes （生活目標・健康目標） live in this database's
// view_month_notes, are written through setViewMonthNote
// (daily.write: Admin and Editor), and ride getRange for the
// months the range covers — the student view's range included,
// whose bundle is otherwise stripped to the student whitelist:
// no duty assignments, no absences, no staff-only items or
// events, no names. Runs only when SCHEDULE_DATABASE_URL is
// set (vitest.config.ts points it at the test database).
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=full-token";
const DATE = "2027-10-02";
const A = "school-a";

type Record_ = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const meta = { revision: 1, updatedBy: "user-a", updatedVia: "platform" };

class FakePlatform {
  /** How many times the absences list was asked for: a
   *  non-staff range must not ask at all. */
  absenceRequests = 0;
  days: Record_[] = [
    {
      ...meta,
      schoolId: A,
      id: "day-1",
      date: DATE,
      dayType: "event_day",
      dayTypeLabel: null,
      dayScheduleId: null,
      weekdaySwap: null,
      note: null,
    },
  ];
  holidays: Record_[] = [
    { ...meta, schoolId: A, id: "hol-1", date: DATE, name: "テスト休日", kind: "school_holiday" },
  ];
  events = new Map<string, Record_>();
  absences = new Map<string, Record_>();
  masters: Record<string, Record_[]> = {
    staff: [{ id: "teacher-a1", name: "先生A", active: true }],
    grades: [{ id: "grade-1", name: "1年" }],
    "day-patterns": [{ id: "pattern-a", code: "A", name: "A日課" }],
  };
  subdivisions: Record_[] = [{ id: "subdiv-annual", code: "leave", key: "annual", label: "年休" }];

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = String(input).replace("http://platform.test", "");
    const [path, query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record_) : null;
    return Promise.resolve(this.route(method, path as string, params, body));
  };

  private route(
    method: string,
    path: string,
    params: URLSearchParams,
    body: Record_ | null,
  ): Response {
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (method === "GET" && path === "/platform/api/v1/calendar/days") {
      return jsonResponse(200, {
        items: this.days.filter((d) => (d.date as string) >= from && (d.date as string) <= to),
      });
    }
    if (method === "GET" && path === "/platform/api/v1/calendar/holidays") {
      return jsonResponse(200, {
        items: this.holidays.filter((h) => (h.date as string) >= from && (h.date as string) <= to),
      });
    }
    if (method === "GET" && path === "/platform/api/v1/calendar/events") {
      const audience = (params.get("audience") ?? "staff") as Audience;
      const inRange = [...this.events.values()].filter((e) =>
        eventInRange(
          e as { datePrecision: "day"; startsOn: string | null; endsOn: string | null },
          from,
          to,
        ),
      );
      const visible = filterVisible(
        inRange as { visibility: "staff_only" }[],
        audience,
      ) as Record_[];
      const items = visible.map((event) => {
        if (audience === "staff") return event;
        const shaped = { ...(forAudience(event as { assignees: unknown[] }, audience) as Record_) };
        delete shaped.createdBy;
        delete shaped.updatedBy;
        return shaped;
      });
      return jsonResponse(200, { items });
    }
    if (method === "GET" && path === "/platform/api/v1/calendar/absences") {
      this.absenceRequests += 1;
      const items = [...this.absences.values()].filter(
        (a) => (a.fromDate as string) <= to && (a.toDate as string) >= from,
      );
      return jsonResponse(200, { items });
    }
    if (method === "POST" && path === "/platform/api/v1/calendar/events") {
      const record: Record_ = { ...(body ?? {}), revision: 1 };
      this.events.set(record.id as string, record);
      return jsonResponse(201, record);
    }
    if (method === "POST" && path === "/platform/api/v1/calendar/absences") {
      const record: Record_ = { ...(body ?? {}), revision: 1 };
      this.absences.set(record.id as string, record);
      return jsonResponse(201, record);
    }
    if (method === "GET" && path === "/platform/api/v1/auth/me") {
      return jsonResponse(200, {
        user: { id: "user-a", name: "先生A", email: "a@example.test" },
        school: { schoolId: A, name: "テスト学校", slug: "test" },
        teacherId: "teacher-a1",
      });
    }
    if (method === "GET" && path === "/platform/api/v1/calendar/absence-subdivisions") {
      return jsonResponse(200, { items: this.subdivisions });
    }
    const masters = /^\/platform\/api\/v1\/masters\/(.+)$/.exec(path);
    if (method === "GET" && masters) {
      return jsonResponse(200, { items: this.masters[masters[1] as string] ?? [] });
    }
    return jsonResponse(404, { error: "見つかりません" });
  }
}

const dutySource: DutyPlatformSource = {
  async listStaff() {
    return [{ id: "teacher-a1", active: true }];
  },
  async listCalendarDays() {
    return [];
  },
  async listAbsences() {
    return [];
  },
  async listTerms() {
    return [];
  },
};

function auth(role: Role): AuthContext {
  return {
    userId: `user-${A}`,
    schoolId: A,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

const eventPayload = (overrides: Record_): Record_ => ({
  kind: "event",
  kindLabel: null,
  datePrecision: "day",
  startsOn: DATE,
  endsOn: DATE,
  time: null,
  locationId: null,
  locationText: null,
  description: null,
  certainty: "confirmed",
  visibility: "student",
  targets: [],
  impacts: [],
  assignees: [{ personId: "teacher-a1", freeTextName: null, role: "担当" }],
  createdBy: "user-a",
  updatedBy: "user-a",
  ...overrides,
});

describe.skipIf(!url)("view month notes (Issue #46)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let range: ReturnType<typeof createRangeActions>;
  let views: ReturnType<typeof createViewActions>;
  let fake: FakePlatform;

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    const db: Db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);

    fake = new FakePlatform();
    const client = createPlatformApiClient({
      baseUrl: "http://platform.test",
      fetchImpl: fake.fetch,
    });
    range = createRangeActions(db, client, dutySource);
    views = createViewActions(db);
    const defs = createDefinitionActions(db);
    const daily = createDailyValueActions(db);
    const duties = createDutyActions(db, dutySource);
    const events = createEventActions(db, client);
    const adminA = auth("Admin");
    const editorA = auth("Editor");

    // The school has turned the student table on: lunch and
    // dismissal reach students, the staff note never does.
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-lunch",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "student",
      options: [
        { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
      ],
    });
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-dismissal",
      key: "dismissal",
      name: "下校時刻",
      valueType: "time",
      granularity: "day",
      defaultVisibility: "student",
    });
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-staff-note",
      key: "staff_note",
      name: "職員メモ",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
    });
    await duties.setDutyAssignment.run(adminA, {
      dutyDefinitionId: "duty-day",
      date: DATE,
      slot: "all_day",
      personId: "teacher-a1",
    });

    // Both views name the same over-broad columns — a staff-only
    // item column and a duty column included — so the range's
    // audience shaping, not the column list, is what the student
    // assertions below measure. Creating the student view also
    // proves the two_column layout passes the definitions'
    // checks (the 0011 layout CHECK included).
    const columns = (prefix: string) => [
      { id: `${prefix}-events`, sourceKind: "event_category" as const, sort: 1 },
      {
        id: `${prefix}-lunch`,
        sourceKind: "daily_item" as const,
        itemDefinitionId: "item-lunch",
        sort: 2,
      },
      {
        id: `${prefix}-dismissal`,
        sourceKind: "daily_item" as const,
        itemDefinitionId: "item-dismissal",
        sort: 3,
      },
      {
        id: `${prefix}-note`,
        sourceKind: "daily_item" as const,
        itemDefinitionId: "item-staff-note",
        sort: 4,
      },
      { id: `${prefix}-duty`, sourceKind: "duty" as const, dutyDefinitionId: "duty-day", sort: 5 },
    ];
    const studentView = await views.upsertViewDefinition.run(adminA, {
      id: "view-student",
      name: "生徒用月表",
      layout: "two_column",
      audience: "student",
      periodScope: "month",
      columns: columns("col-student"),
    });
    expect(studentView.layout).toBe("two_column");
    await views.upsertViewDefinition.run(adminA, {
      id: "view-staff",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: columns("col-staff"),
    });

    await daily.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    await daily.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-dismissal",
      value: "14:30",
    });
    await daily.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-staff-note",
      value: "職員だけのメモ",
    });

    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-day", title: "運動会" }),
    });
    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-guardian", title: "保護者会", visibility: "guardian" }),
    });
    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-staff-only", title: "職員会議", visibility: "staff_only" }),
    });
    await events.createAbsence.run(editorA, {
      cookie: COOKIE,
      absence: {
        id: "abs-leave",
        staffId: "teacher-a1",
        fromDate: DATE,
        toDate: DATE,
        time: { kind: "all_day" },
        kind: "leave",
        certainty: "confirmed",
        purpose: "私用",
        note: "メモ",
        subdivisionKey: "annual",
      },
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("saves a month note and reads it back on the range, normalised", async () => {
    const saved = await views.setViewMonthNote.run(auth("Editor"), {
      viewId: "view-student",
      month: "2027-10",
      lifeGoal: "  あいさつを自分からしよう  ",
      healthGoal: "早寝・早起き・朝ごはん",
    });
    expect(saved).toEqual({
      month: "2027-10",
      lifeGoal: "あいさつを自分からしよう",
      healthGoal: "早寝・早起き・朝ごはん",
    });
    // A blank goal is no goal: rewriting with whitespace clears
    // that side and keeps the other.
    const cleared = await views.setViewMonthNote.run(auth("Admin"), {
      viewId: "view-student",
      month: "2027-11",
      lifeGoal: "ろうかを歩こう",
      healthGoal: "   ",
    });
    expect(cleared).toEqual({ month: "2027-11", lifeGoal: "ろうかを歩こう", healthGoal: null });

    const october = await range.getRange.run(auth("Editor"), {
      from: "2027-10-01",
      to: "2027-10-31",
      viewId: "view-student",
      cookie: COOKIE,
    });
    expect(october.monthNotes).toEqual([
      {
        month: "2027-10",
        lifeGoal: "あいさつを自分からしよう",
        healthGoal: "早寝・早起き・朝ごはん",
      },
    ]);
    // A range spanning both months carries both notes, in
    // month order; the staff view, which has no notes written,
    // carries none — notes belong to their view.
    const spanning = await range.getRange.run(auth("Editor"), {
      from: "2027-10-01",
      to: "2027-11-30",
      viewId: "view-student",
      cookie: COOKIE,
    });
    expect(spanning.monthNotes.map((n) => n.month)).toEqual(["2027-10", "2027-11"]);
    const staff = await range.getRange.run(auth("Editor"), {
      from: "2027-10-01",
      to: "2027-10-31",
      viewId: "view-staff",
      cookie: COOKIE,
    });
    expect(staff.monthNotes).toEqual([]);
  });

  it("refuses a Viewer and a missing view", async () => {
    await expect(
      views.setViewMonthNote.run(auth("Viewer"), {
        viewId: "view-student",
        month: "2027-12",
        lifeGoal: "かきかた",
        healthGoal: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      views.setViewMonthNote.run(auth("Admin"), {
        viewId: "view-missing",
        month: "2027-12",
        lifeGoal: "かきかた",
        healthGoal: null,
      }),
    ).rejects.toThrow("view definition not found: view-missing");
  });

  it("refuses a month that is not a month, and a goal past the cap", async () => {
    // The month is YYYY-MM with a real month in it: 2027-13 is
    // the right shape and still not a month.
    await expect(
      views.setViewMonthNote.run(auth("Admin"), {
        viewId: "view-student",
        month: "2027-13",
        lifeGoal: "かきかた",
        healthGoal: null,
      }),
    ).rejects.toThrow();
    // The goals head the printed sheet, so they are capped at
    // 100 characters.
    await expect(
      views.setViewMonthNote.run(auth("Admin"), {
        viewId: "view-student",
        month: "2027-12",
        lifeGoal: "あ".repeat(101),
        healthGoal: null,
      }),
    ).rejects.toThrow();
  });

  it("the student view's range holds no duties, absences, staff-only values or names", async () => {
    const before = fake.absenceRequests;
    const result = await range.getRange.run(auth("Editor"), {
      from: "2027-10-01",
      to: "2027-10-31",
      viewId: "view-student",
      cookie: COOKIE,
    });
    // The absences were never even asked for.
    expect(fake.absenceRequests).toBe(before);
    // The duty column and the staff-only item column are gone
    // from the view the range carries.
    expect(result.view.columns.map((c) => c.sourceKind)).toEqual([
      "event_category",
      "daily_item",
      "daily_item",
    ]);
    const day = result.days.find((d) => d.date === DATE) as (typeof result.days)[number];
    expect(day.absences).toEqual([]);
    expect(day.dutyAssignments).toEqual([]);
    expect(result.conflicts).toEqual([]);
    // Only the student-reaching items' values stand.
    expect(day.dailyValues.map((v) => v.itemDefinitionId).sort()).toEqual([
      "item-dismissal",
      "item-lunch",
    ]);
    // Only the student-reaching event stands, nameless.
    expect(day.events.map((e) => e["title"])).toEqual(["運動会"]);
    expect(day.events[0]?.["assignees"]).toEqual([]);
    const text = JSON.stringify(result);
    for (const hidden of [
      "職員会議",
      "保護者会",
      "職員だけのメモ",
      "teacher-a1",
      "先生A",
      "年休",
    ]) {
      expect(text).not.toContain(hidden);
    }
    // And the month's goals head the bundle, as the screen
    // expects them.
    expect(result.monthNotes).toEqual([
      {
        month: "2027-10",
        lifeGoal: "あいさつを自分からしよう",
        healthGoal: "早寝・早起き・朝ごはん",
      },
    ]);
  });

  it("the staff view over the same columns still reads everything", async () => {
    const result = await range.getRange.run(auth("Editor"), {
      from: "2027-10-01",
      to: "2027-10-31",
      viewId: "view-staff",
      cookie: COOKIE,
    });
    const day = result.days.find((d) => d.date === DATE) as (typeof result.days)[number];
    expect(day.absences.map((a) => a.id)).toEqual(["abs-leave"]);
    expect(day.dutyAssignments.map((a) => a.personId)).toEqual(["teacher-a1"]);
    expect(day.dailyValues.map((v) => v.itemDefinitionId).sort()).toEqual([
      "item-dismissal",
      "item-lunch",
      "item-staff-note",
    ]);
    expect(day.events.map((e) => e["title"]).sort()).toEqual(["保護者会", "職員会議", "運動会"]);
  });
});
