import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthAccessError, type AuthContext, type Role } from "@school-manage/platform-client";
import {
  eventInRange,
  filterVisible,
  forAudience,
  type Audience,
} from "@school-manage/calendar-types";
import { createScheduleActions } from "../src/composition.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPlatformApiClient, PlatformRelayError } from "../src/platformClient.js";

// Publication tests (Issue #40): issuing a view's month table
// renders the document on the server from the same getRange
// bundle the screen draws, stores it with the version record,
// and never rewrites it. The fake platform shapes its answers
// the way the real one does (audience filter on events, absence
// records for staff reads), so what the document contains — and
// what it must not contain — is judged on the real data path.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=test-token";
const SCHOOL = "school-40";
const DATE = "2027-10-02";
const MONTH = "2027-10";

type Record_ = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function auth(role: Role): AuthContext {
  return {
    userId: "user-40",
    schoolId: SCHOOL,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

class FakePlatform {
  days: Record_[] = [
    {
      revision: 1,
      schoolId: SCHOOL,
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
    {
      revision: 1,
      schoolId: SCHOOL,
      id: "hol-1",
      date: "2027-10-04",
      name: "スポーツの日",
      kind: "national_holiday",
    },
  ];
  events = new Map<string, Record_>();
  absences = new Map<string, Record_>();
  masters: Record<string, Record_[]> = {
    staff: [
      { id: "teacher-a1", name: "先生A", active: true },
      { id: "teacher-a2", name: "先生B", active: true },
    ],
    grades: [
      { id: "grade-1", name: "1年" },
      { id: "grade-2", name: "2年" },
      { id: "grade-3", name: "3年" },
    ],
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
      return jsonResponse(200, {
        items: [...this.absences.values()].filter(
          (a) => (a.fromDate as string) <= to && (a.toDate as string) >= from,
        ),
      });
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
        user: { id: "user-40", name: "先生A" },
        school: { schoolId: SCHOOL, name: "テスト学校", slug: "test" },
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
  createdBy: "user-40",
  updatedBy: "user-40",
  ...overrides,
});

describe.skipIf(!url)("publications (Issue #40)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let actions: ReturnType<typeof createScheduleActions>;

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
    actions = createScheduleActions(db, client, COOKIE);
    const adminA = auth("Admin");
    const editorA = auth("Editor");

    await actions.upsertItemDefinition.run(adminA, {
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
    await actions.upsertItemDefinition.run(adminA, {
      id: "item-dismissal",
      key: "dismissal",
      name: "下校時刻",
      valueType: "time",
      targetPlatformAxis: "grade",
      granularity: "day",
      defaultVisibility: "guardian",
    });
    await actions.upsertItemDefinition.run(adminA, {
      id: "item-staff-note",
      key: "staff_note",
      name: "職員メモ",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await actions.upsertItemDefinition.run(adminA, {
      id: "item-staff-movement",
      key: "staff_movement",
      name: "職員動静",
      valueType: "event_list",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await actions.upsertDutyDefinition.run(adminA, {
      id: "duty-day",
      name: "日直",
      granularity: "day",
      applicablePeriod: "all_year",
    });
    await actions.setDutyAssignment.run(adminA, {
      dutyDefinitionId: "duty-day",
      date: DATE,
      slot: "all_day",
      personId: "teacher-a1",
    });
    await actions.upsertViewDefinition.run(adminA, {
      id: "view-staff",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [
        { id: "col-staff-events", sourceKind: "event_category" },
        { id: "col-staff-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        { id: "col-staff-dismissal", sourceKind: "daily_item", itemDefinitionId: "item-dismissal" },
        {
          id: "col-staff-movement",
          sourceKind: "daily_item",
          itemDefinitionId: "item-staff-movement",
        },
        { id: "col-staff-duty", sourceKind: "duty", dutyDefinitionId: "duty-day" },
        { id: "col-staff-note", sourceKind: "daily_item", itemDefinitionId: "item-staff-note" },
      ],
    });
    await actions.upsertViewDefinition.run(adminA, {
      id: "view-guardian",
      name: "保護者用月表",
      layout: "month_rows",
      audience: "guardian",
      periodScope: "month",
      printSettings: { paper: "A3" },
      columns: [
        { id: "col-guardian-events", sourceKind: "event_category" },
        { id: "col-guardian-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        {
          id: "col-guardian-dismissal",
          sourceKind: "daily_item",
          itemDefinitionId: "item-dismissal",
        },
      ],
    });

    await actions.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    for (const gradeId of ["grade-1", "grade-2", "grade-3"]) {
      await actions.setDailyValue.run(editorA, {
        date: DATE,
        itemDefinitionId: "item-dismissal",
        target: { axis: "grade", id: gradeId },
        value: "14:30",
      });
    }
    await actions.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-staff-note",
      value: "職員だけのメモ",
    });
    await actions.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-day", title: "運動会" }),
    });
    await actions.createEvent.run(editorA, {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-staff-only", title: "職員会議", visibility: "staff_only" }),
    });
    await actions.createAbsence.run(editorA, {
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
        note: null,
        subdivisionKey: "annual",
      },
    });
    await actions.applyDefaultKindTemplates.run(adminA, null);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("publishing is the publish permission's, on the server", async () => {
    await expect(
      actions.createPublication.run(auth("Viewer"), {
        cookie: COOKIE,
        viewId: "view-staff",
        targetMonth: MONTH,
        versionLabel: "見るだけの人の版",
      }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    // Reading the list is view.read: a Viewer may.
    await expect(actions.getPublications.run(auth("Viewer"), {})).resolves.toEqual([]);
  });

  it("a staff publication carries the month as the screen shows it", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: MONTH,
      versionLabel: "10月2日版",
      note: "最初の配布",
    })) as Record<string, unknown>;
    expect(meta["versionLabel"]).toBe("10月2日版");
    expect(meta["targetMonth"]).toBe(MONTH);
    expect(meta["snapshotNote"]).toBe("最初の配布");
    expect(meta["documentHtml"]).toBeUndefined();

    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    expect(html).toContain("テスト学校");
    expect(html).toContain("2027年10月 行事予定表");
    expect(html).toContain("版：10月2日版");
    expect(html).toContain("size: A4 landscape");
    // The screen's content, as the screen composes it: events,
    // the staff-only item, the duty holder, the leave led by its
    // holder with the subdivision's label, and the grouped
    // per-grade dismissal times of DESIGN 4.8.2.
    expect(html).toContain("運動会");
    expect(html).toContain("職員会議");
    expect(html).toContain("職員だけのメモ");
    expect(html).toContain("先生A（年休）");
    expect(html).toContain("1～3年 14:30");
  });

  it("a guardian publication has no staff-only items, duties or names", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-guardian",
      targetMonth: MONTH,
      versionLabel: "保護者版",
    })) as Record<string, unknown>;
    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    expect(html).toContain("運動会");
    expect(html).toContain("1～3年 14:30");
    expect(html).not.toContain("職員会議");
    expect(html).not.toContain("職員だけのメモ");
    expect(html).not.toContain("先生A");
    expect(html).not.toContain("年休");
    expect(html).not.toContain("日直");
    // The view's own print settings are the defaults (DESIGN
    // schedule 9.1): A3 from the view, landscape from the defaults.
    expect(html).toContain("size: A3 landscape");
  });

  it("print settings chosen at publish time are recorded and used", async () => {
    const meta = (await actions.createPublication.run(auth("Admin"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: MONTH,
      versionLabel: "A3縦版",
      printSettings: { paper: "A3", orientation: "portrait", marginMm: 15, fontScale: "large" },
    })) as Record<string, unknown>;
    expect(meta["printSettings"]).toEqual({
      paper: "A3",
      orientation: "portrait",
      marginMm: 15,
      fontScale: "large",
    });
    const doc = (await actions.getPublication.run(auth("Admin"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    expect(html).toContain("size: A3 portrait");
    expect(html).toContain("margin: 15mm");
  });

  it("an issued document does not change when the data does", async () => {
    const first = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: MONTH,
      versionLabel: "第1版",
    })) as Record<string, unknown>;
    const issued = (await actions.getPublication.run(auth("Editor"), {
      id: first["id"] as string,
    })) as Record<string, unknown>;
    const issuedHtml = issued["documentHtml"] as string;
    expect(issuedHtml).toContain("○");
    expect(issuedHtml).not.toContain("文化祭");

    // The data moves on: lunch is cancelled and a new event lands.
    await actions.setDailyValue.run(auth("Editor"), {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "no",
    });
    await actions.createEvent.run(auth("Editor"), {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-new", title: "文化祭" }),
    });

    const reread = (await actions.getPublication.run(auth("Editor"), {
      id: first["id"] as string,
    })) as Record<string, unknown>;
    expect(reread["documentHtml"]).toBe(issuedHtml);

    // A new issue reflects the new data; the list keeps both,
    // newest first.
    const second = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: MONTH,
      versionLabel: "第2版",
    })) as Record<string, unknown>;
    const secondDoc = (await actions.getPublication.run(auth("Editor"), {
      id: second["id"] as string,
    })) as Record<string, unknown>;
    const secondHtml = secondDoc["documentHtml"] as string;
    expect(secondHtml).toContain("文化祭");
    expect(secondHtml).not.toBe(issuedHtml);

    const list = (await actions.getPublications.run(auth("Viewer"), {
      viewId: "view-staff",
    })) as Record<string, unknown>[];
    const labels = list.map((p) => p["versionLabel"]);
    expect(labels.indexOf("第2版")).toBeLessThan(labels.indexOf("第1版"));
    expect(labels).toContain("10月2日版");
  });

  it("unknown views and publications are refused by name", async () => {
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-nope",
        targetMonth: MONTH,
        versionLabel: "ない版",
      }),
    ).rejects.toThrow(/view definition not found/);
    await expect(actions.getPublication.run(auth("Viewer"), { id: "pub-nope" })).rejects.toThrow(
      /publication not found/,
    );
  });

  it("a stored document never carries a script element, even from typed text", async () => {
    // The stored document is shown as HTML (the sandboxed preview
    // now, a public page later), so whatever a person typed must
    // arrive escaped — never as a live script element (PR #79
    // review, recommendation 1).
    await actions.createEvent.run(auth("Editor"), {
      cookie: COOKIE,
      event: eventPayload({
        id: "ev-script",
        title: "点検<script>alert(1)</script>",
      }),
    });
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: MONTH,
      versionLabel: "スクリプト検査版",
    })) as Record<string, unknown>;
    const doc = (await actions.getPublication.run(auth("Editor"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("a view with publications cannot be deleted, and both stay", async () => {
    // The publications foreign key is restrict: the refusal is a
    // 409 carrying the reason and the alternative, not a 500
    // (PR #79 review, recommendation 2).
    const error: unknown = await actions.deleteViewDefinition
      .run(auth("Admin"), { id: "view-staff" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 409 });
    expect((error as PlatformRelayError).body).toEqual({
      error: "発行した版があるビューは削除できません",
    });

    // The view and its publications are untouched.
    const views = await actions.getViews.run(auth("Admin"), {});
    expect(views.map((v) => v.id)).toContain("view-staff");
    const list = (await actions.getPublications.run(auth("Viewer"), {
      viewId: "view-staff",
    })) as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);

    // A view with no publications still deletes as before.
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-disposable",
      name: "使い捨てビュー",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [],
    });
    await expect(
      actions.deleteViewDefinition.run(auth("Admin"), { id: "view-disposable" }),
    ).resolves.toEqual({ deleted: true });
    const after = await actions.getViews.run(auth("Admin"), {});
    expect(after.map((v) => v.id)).not.toContain("view-disposable");
  });
});
