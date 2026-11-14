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

// Range read tests (Issue #33): getRange bundles, per date, the
// platform's calendar (read from a fake platform that applies the
// real API's audience filter and absence privacy shaping) with this
// database's daily values, duty assignments and additional items;
// getBootstrap gathers the definitions and masters a screen starts
// with. The privacy judgments stay the platform's — the fake shapes
// its answers the way the real platform does, and the tests check
// that the shapes pass through untouched.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=full-token";
/** Under this cookie the fake platform hands a colleague's leave
 *  back in its restricted shape (no purpose / note / subdivision),
 *  as it does for a reader who is neither Admin nor the person. */
const RESTRICTED_COOKIE = "platform_session=colleague-token";

const DATE = "2027-10-02";
const A = "school-a";
const B = "school-b";

type Record_ = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const meta = { revision: 1, updatedBy: "user-a", updatedVia: "platform" };

class FakePlatform {
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

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = String(input).replace("http://platform.test", "");
    const [path, query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    const method = init?.method ?? "GET";
    const cookie = new Headers(init?.headers).get("cookie") ?? undefined;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record_) : null;
    return Promise.resolve(this.route(method, path as string, params, body, cookie));
  };

  private route(
    method: string,
    path: string,
    params: URLSearchParams,
    body: Record_ | null,
    cookie?: string,
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
      const items = [...this.absences.values()]
        .filter((a) => (a.fromDate as string) <= to && (a.toDate as string) >= from)
        .map((absence) => {
          if (cookie !== RESTRICTED_COOKIE || absence.kind !== "leave") return absence;
          const restricted = { ...absence };
          delete restricted.purpose;
          delete restricted.note;
          delete restricted.subdivisionKey;
          return restricted;
        });
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
  async listTerms() {
    return [];
  },
};

function auth(schoolId: string, role: Role, teacherId: string | null = null): AuthContext {
  return {
    userId: `user-${schoolId}`,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId,
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
  visibility: "guardian",
  targets: [],
  impacts: [],
  assignees: [{ personId: "teacher-a1", freeTextName: null, role: "担当" }],
  createdBy: "user-a",
  updatedBy: "user-a",
  ...overrides,
});

describe.skipIf(!url)("schedule range reads (getRange / getBootstrap)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let range: ReturnType<typeof createRangeActions>;

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

    const fake = new FakePlatform();
    const client = createPlatformApiClient({
      baseUrl: "http://platform.test",
      fetchImpl: fake.fetch,
    });
    range = createRangeActions(db, client);
    const defs = createDefinitionActions(db);
    const daily = createDailyValueActions(db);
    const duties = createDutyActions(db, dutySource);
    const events = createEventActions(db, client);
    const views = createViewActions(db);
    const adminA = auth(A, "Admin");

    // Definitions: a guardian-visible lunch item and a staff-only
    // note item (used for daily values and for event values alike).
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-lunch",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "guardian",
      options: [
        { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
      ],
    });
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-staff-note",
      key: "staff_note",
      name: "職員メモ",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await defs.upsertTargetGroup.run(adminA, { id: "grp-club", key: "club", name: "部活動" });
    await defs.upsertTarget.run(adminA, {
      id: "tgt-soccer",
      targetGroupId: "grp-club",
      name: "サッカー部",
    });
    await defs.upsertItemDefinition.run(auth(B, "Admin"), {
      id: "item-lunch-b",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "guardian",
      options: [
        { id: "opt-lunch-b-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-lunch-b-no", code: "no", label: "×", sort: 2 },
      ],
    });

    // A duty definition and one manual assignment on DATE.
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

    // Views: a staff view and a guardian view over the same columns.
    const columns = (prefix: string) => [
      { id: `${prefix}-lunch`, sourceKind: "daily_item" as const, itemDefinitionId: "item-lunch" },
      {
        id: `${prefix}-note`,
        sourceKind: "daily_item" as const,
        itemDefinitionId: "item-staff-note",
      },
      { id: `${prefix}-duty`, sourceKind: "duty" as const, dutyDefinitionId: "duty-day" },
    ];
    await views.upsertViewDefinition.run(adminA, {
      id: "view-staff",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: columns("col-staff"),
    });
    await views.upsertViewDefinition.run(adminA, {
      id: "view-guardian",
      name: "保護者用月表",
      layout: "month_rows",
      audience: "guardian",
      periodScope: "month",
      columns: columns("col-guardian"),
    });

    // Daily values on DATE (and school B's, which must not leak).
    const editorA = auth(A, "Editor");
    await daily.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    await daily.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-staff-note",
      value: "職員だけのメモ",
    });
    await daily.setDailyValue.run(auth(B, "Editor"), {
      date: DATE,
      itemDefinitionId: "item-lunch-b",
      value: "no",
    });

    // Platform records, saved through the relay as the screens do,
    // with their additional items.
    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-day", title: "運動会" }),
      values: [{ itemDefinitionId: "item-staff-note", value: "体育館集合" }],
    });
    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-staff-only", title: "職員会議", visibility: "staff_only" }),
    });
    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({
        id: "ev-month",
        title: "作品展（月未定）",
        datePrecision: "month",
        startsOn: "2027-10-15",
        endsOn: "2027-10-15",
      }),
    });
    await events.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({
        id: "ev-undecided",
        title: "研究発表（時期未定）",
        datePrecision: "undecided",
        startsOn: "2027-04-01",
        endsOn: "2027-04-01",
      }),
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
      values: [{ itemDefinitionId: "item-staff-note", value: "休暇の追加項目" }],
    });

    await events.applyDefaultKindTemplates.run(adminA, null);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("bundles one day: calendar, events, daily values, duties and additional items", async () => {
    const result = await range.getRange.run(auth(A, "Editor"), {
      from: "2027-10-01",
      to: "2027-10-03",
      viewId: "view-staff",
      cookie: COOKIE,
    });
    expect(result.days.map((d) => d.date)).toEqual(["2027-10-01", "2027-10-02", "2027-10-03"]);
    const day = result.days[1] as (typeof result.days)[number];
    expect(day.day).toMatchObject({ id: "day-1", dayType: "event_day" });
    expect(day.holidays.map((h) => h.name)).toEqual(["テスト休日"]);
    expect(day.events.map((e) => e.id).sort()).toEqual(["ev-day", "ev-staff-only"]);
    expect(day.absences.map((a) => a.id)).toEqual(["abs-leave"]);
    // The platform's full shape passes through untouched.
    expect(day.absences[0]).toMatchObject({ subdivisionKey: "annual", purpose: "私用" });
    // Only school A's two values: school B's lunch stays in B.
    expect(day.dailyValues.map((v) => v.itemDefinitionId).sort()).toEqual([
      "item-lunch",
      "item-staff-note",
    ]);
    expect(day.dutyAssignments.map((a) => a.personId)).toEqual(["teacher-a1"]);
    expect(result.eventValues.map((v) => `${v.subjectId}:${v.valueText}`).sort()).toEqual([
      "abs-leave:休暇の追加項目",
      "ev-day:体育館集合",
    ]);
    // The month-precision event is that month's undecided, not a day.
    expect(result.undecided).toEqual([
      { month: "2027-10", events: [expect.objectContaining({ id: "ev-month" })] },
    ]);
    expect(result.days.every((d) => !d.events.some((e) => e.id === "ev-month"))).toBe(true);
    // The conflict slot is present and empty until Issue #31.
    expect(result.conflicts).toEqual([]);
    expect(result.view.columns).toHaveLength(3);
  });

  it("a guardian view gets no staff-only items, duties, absences or assignee names", async () => {
    const result = await range.getRange.run(auth(A, "Editor"), {
      from: "2027-10-01",
      to: "2027-10-03",
      viewId: "view-guardian",
      cookie: COOKIE,
    });
    // Only the lunch column survives: the staff-only item's column
    // and the duty column are filtered out.
    expect(result.view.columns.map((c) => c.id)).toEqual(["col-guardian-lunch"]);
    const day = result.days[1] as (typeof result.days)[number];
    expect(day.dailyValues.map((v) => v.itemDefinitionId)).toEqual(["item-lunch"]);
    expect(day.dutyAssignments).toEqual([]);
    expect(day.absences).toEqual([]);
    expect(day.events.map((e) => e.id)).toEqual(["ev-day"]);
    // The platform stripped the assignees for this audience.
    expect(day.events[0]?.assignees).toEqual([]);
    // The one additional item hangs on a staff-only item definition.
    expect(result.eventValues).toEqual([]);
  });

  it("passes the platform's leave shaping through, and gates its values on it", async () => {
    const result = await range.getRange.run(auth(A, "Editor"), {
      from: "2027-10-01",
      to: "2027-10-03",
      viewId: "view-staff",
      cookie: RESTRICTED_COOKIE,
    });
    const day = result.days[1] as (typeof result.days)[number];
    const absence = day.absences[0] as Record_;
    expect(absence.id).toBe("abs-leave");
    // Exactly the restricted shape the platform handed over.
    expect(absence).not.toHaveProperty("purpose");
    expect(absence).not.toHaveProperty("subdivisionKey");
    // Its additional items are gated on that shape, as in
    // getEventValues; the event's own values are unaffected.
    expect(result.eventValues.map((v) => v.subjectId)).toEqual(["ev-day"]);
  });

  it("returns undecided events under their school year when the range covers it", async () => {
    const result = await range.getRange.run(auth(A, "Editor"), {
      from: "2027-04-01",
      to: "2028-03-31",
      viewId: "view-staff",
      cookie: COOKIE,
    });
    expect(result.days).toHaveLength(366);
    expect(result.undecided).toEqual([
      { month: "2027-10", events: [expect.objectContaining({ id: "ev-month" })] },
      { month: null, events: [expect.objectContaining({ id: "ev-undecided" })] },
    ]);
  });

  it("refuses a range longer than one year, and an unknown view", async () => {
    await expect(
      range.getRange.run(auth(A, "Editor"), {
        from: "2027-04-01",
        to: "2028-04-01",
        viewId: "view-staff",
        cookie: COOKIE,
      }),
    ).rejects.toThrow(/too long/);
    await expect(
      range.getRange.run(auth(A, "Editor"), {
        from: "2027-10-01",
        to: "2027-10-03",
        viewId: "view-nope",
        cookie: COOKIE,
      }),
    ).rejects.toThrow(/view definition not found/);
    // Another school's view is not this school's to read.
    await expect(
      range.getRange.run(auth(B, "Editor"), {
        from: "2027-10-01",
        to: "2027-10-03",
        viewId: "view-staff",
        cookie: COOKIE,
      }),
    ).rejects.toThrow(/view definition not found/);
  });

  it("bootstrap gathers the school, definitions, templates, masters and my standing", async () => {
    const result = await range.getBootstrap.run(auth(A, "Editor", "teacher-a1"), {
      cookie: COOKIE,
    });
    expect(result.school).toEqual({ id: A, name: "テスト学校" });
    expect(result.role).toBe("Editor");
    expect(result.teacherId).toBe("teacher-a1");
    expect(result.permissions).toContain("view.read");
    expect(result.permissions).toContain("daily.write");
    expect(result.permissions).not.toContain("definition.write");
    expect(result.views.map((v) => v.id).sort()).toEqual(["view-guardian", "view-staff"]);
    expect(result.itemDefinitions.map((i) => i.id).sort()).toEqual([
      "item-lunch",
      "item-staff-note",
    ]);
    expect(result.targetGroups.map((g) => g.id)).toEqual(["grp-club"]);
    expect(result.targetGroups[0]?.targets.map((t) => t.id)).toEqual(["tgt-soccer"]);
    expect(result.kindTemplates).toHaveLength(4);
    expect(result.masters.staff.map((s) => s.id)).toEqual(["teacher-a1"]);
    expect(result.masters.grades.map((g) => g.id)).toEqual(["grade-1"]);
    expect(result.masters.dayPatterns.map((p) => p.id)).toEqual(["pattern-a"]);
  });
});
