import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createDailyValueActions } from "../src/dailyValues/actions.js";
import { createViewActions } from "../src/views/actions.js";
import { createSummaryActions } from "../src/summary/actions.js";
import { createPlatformApiClient } from "../src/platformClient.js";

// Summary tests (Issue #47; DESIGN schedule 8): the counts are
// derived on every read — school days from the platform's day
// types, an aggregatable item's days from its daily values'
// symbols (the options' counts_as conditions), per target as
// well as overall. Nothing is stored, so the second test below
// changes the platform's day record and reads a changed count
// back. Runs only when SCHEDULE_DATABASE_URL is set
// (vitest.config.ts points it at the test database).
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=full-token";
const A = "school-a";
// One week, Friday to Thursday: five weekdays, a weekend.
const FROM = "2027-10-01";
const TO = "2027-10-07";

type Record_ = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const meta = { revision: 1, updatedBy: "user-a", updatedVia: "platform" };

class FakePlatform {
  /** The day records the platform holds; the tests rewrite
   *  this list to prove the counts follow it (nothing stored). */
  days: Record_[] = [];
  holidays: Record_[] = [];
  masters: Record<string, Record_[]> = {
    grades: [1, 2, 3, 4, 5, 6].map((n) => ({
      ...meta,
      id: `grade-${n}`,
      name: `${n}年`,
      active: true,
    })),
  };

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = String(input).replace("http://platform.test", "");
    const [path, query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    const method = init?.method ?? "GET";
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (method === "GET" && path === "/platform/api/v1/calendar/days") {
      return Promise.resolve(
        jsonResponse(200, {
          items: this.days.filter((d) => (d.date as string) >= from && (d.date as string) <= to),
        }),
      );
    }
    if (method === "GET" && path === "/platform/api/v1/calendar/holidays") {
      return Promise.resolve(
        jsonResponse(200, {
          items: this.holidays.filter(
            (h) => (h.date as string) >= from && (h.date as string) <= to,
          ),
        }),
      );
    }
    const masters = /^\/platform\/api\/v1\/masters\/(.+)$/.exec(path as string);
    if (method === "GET" && masters) {
      return Promise.resolve(
        jsonResponse(200, { items: this.masters[masters[1] as string] ?? [] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { error: "見つかりません" }));
  };
}

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

describe.skipIf(!url)("summary (Issue #47)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let summary: ReturnType<typeof createSummaryActions>;
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
    summary = createSummaryActions(db, client);
    const defs = createDefinitionActions(db);
    const daily = createDailyValueActions(db);
    const views = createViewActions(db);
    const adminA = auth("Admin");
    const editorA = auth("Editor");

    // Lunch varies by grade and is aggregatable, its ○ counting
    // as a lunch day (the shipped preset's condition shape).
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-lunch",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      targetPlatformAxis: "grade",
      granularity: "day",
      defaultVisibility: "guardian",
      isAggregatable: true,
      options: [
        { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1, countsAs: { lunch_day: true } },
        { id: "opt-lunch-no", code: "no", label: "×", sort: 2, countsAs: { lunch_day: false } },
      ],
    });
    // Cleaning stands in the view but is not aggregatable.
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-cleaning",
      key: "cleaning",
      name: "清掃",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [
        { id: "opt-cleaning-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-cleaning-no", code: "no", label: "×", sort: 2 },
      ],
    });
    // The bus count is aggregatable but no column of the view.
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-bus-days",
      key: "bus_days",
      name: "バス運行",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "guardian",
      isAggregatable: true,
      options: [
        { id: "opt-bus-yes", code: "yes", label: "○", sort: 1, countsAs: { bus_day: true } },
        { id: "opt-bus-no", code: "no", label: "×", sort: 2, countsAs: { bus_day: false } },
      ],
    });
    await views.upsertViewDefinition.run(adminA, {
      id: "view-month",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [
        { id: "col-events", sourceKind: "event_category" as const, sort: 1 },
        {
          id: "col-lunch",
          sourceKind: "daily_item" as const,
          itemDefinitionId: "item-lunch",
          sort: 2,
        },
        {
          id: "col-cleaning",
          sourceKind: "daily_item" as const,
          itemDefinitionId: "item-cleaning",
          sort: 3,
        },
      ],
    });

    // Lunch on three class days: every grade eats, except the
    // sixth years, who are away on their trip for two of the
    // three days and are recorded as not eating (DESIGN
    // schedule 8's exception, held as per-target values).
    for (const date of ["2027-10-01", "2027-10-04", "2027-10-05"]) {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        await daily.setDailyValue.run(editorA, {
          date,
          itemDefinitionId: "item-lunch",
          target: { axis: "grade", id: `grade-${n}` },
          value: n === 6 && date !== "2027-10-01" ? "no" : "yes",
        });
      }
    }
    // Values of the two excluded items, standing in the range
    // to prove they are not counted under this view.
    await daily.setDailyValue.run(editorA, {
      date: "2027-10-01",
      itemDefinitionId: "item-cleaning",
      value: "yes",
    });
    await daily.setDailyValue.run(editorA, {
      date: "2027-10-01",
      itemDefinitionId: "item-bus-days",
      value: "yes",
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("counts lunch days overall and per grade, the sixth years fewer", async () => {
    const result = await summary.getSummary.run(auth("Editor"), {
      from: FROM,
      to: TO,
      viewId: "view-month",
      cookie: COOKIE,
    });
    expect(result.from).toBe(FROM);
    expect(result.viewId).toBe("view-month");
    // Five weekdays, a weekend: the platform holds no day
    // records yet, so the weekday default rules.
    expect(result.total.schoolDays).toBe(5);
    expect(result.total.dayTypeCounts).toEqual([
      { dayType: "class_day", count: 5 },
      { dayType: "event_day", count: 0 },
      { dayType: "attendance_day", count: 0 },
      { dayType: "closed_day", count: 2 },
      { dayType: "long_vacation", count: 0 },
    ]);
    // Only lunch is counted: cleaning is not aggregatable, the
    // bus count is not a column of this view.
    expect(result.total.items.map((i) => i.itemId)).toEqual(["item-lunch"]);
    const lunch = result.total.items[0];
    expect(lunch?.name).toBe("給食");
    expect(lunch?.total).toBe(3);
    expect(lunch?.byTarget).toEqual([
      { targetId: "grade:grade-1", targetName: "1年", count: 3 },
      { targetId: "grade:grade-2", targetName: "2年", count: 3 },
      { targetId: "grade:grade-3", targetName: "3年", count: 3 },
      { targetId: "grade:grade-4", targetName: "4年", count: 3 },
      { targetId: "grade:grade-5", targetName: "5年", count: 3 },
      { targetId: "grade:grade-6", targetName: "6年", count: 1 },
    ]);
    // The whole week falls in one month bucket, which agrees.
    expect(result.months.map((m) => m.month)).toEqual(["2027-10"]);
    expect(result.months[0]?.items[0]?.total).toBe(3);
  });

  it("follows a changed day type — the counts are derived, not stored", async () => {
    // The platform closes the Monday and opens the Saturday as
    // an event day; the very next read must say so.
    fake.days = [
      {
        ...meta,
        schoolId: A,
        id: "day-1004",
        date: "2027-10-04",
        dayType: "closed_day",
        dayTypeLabel: null,
        dayScheduleId: null,
        weekdaySwap: null,
        note: null,
      },
      {
        ...meta,
        schoolId: A,
        id: "day-1002",
        date: "2027-10-02",
        dayType: "event_day",
        dayTypeLabel: null,
        dayScheduleId: null,
        weekdaySwap: null,
        note: null,
      },
    ];
    const result = await summary.getSummary.run(auth("Editor"), {
      from: FROM,
      to: TO,
      viewId: "view-month",
      cookie: COOKIE,
    });
    expect(result.total.schoolDays).toBe(4);
    expect(result.total.dayTypeCounts).toEqual([
      { dayType: "class_day", count: 4 },
      { dayType: "event_day", count: 1 },
      { dayType: "attendance_day", count: 0 },
      { dayType: "closed_day", count: 2 },
      { dayType: "long_vacation", count: 0 },
    ]);
    fake.days = [];
  });

  it("a Viewer may read it (view.read), and a missing view is the range's error", async () => {
    const result = await summary.getSummary.run(auth("Viewer"), {
      from: FROM,
      to: TO,
      viewId: "view-month",
      cookie: COOKIE,
    });
    expect(result.total.schoolDays).toBe(5);
    await expect(
      summary.getSummary.run(auth("Admin"), {
        from: FROM,
        to: TO,
        viewId: "view-missing",
        cookie: COOKIE,
      }),
    ).rejects.toThrow("view definition not found: view-missing");
  });
});
