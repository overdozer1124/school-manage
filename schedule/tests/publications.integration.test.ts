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
import { insertPublication } from "../src/db/publications.js";
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

  it("a student publication is two half-month tables headed by the month's goals (Issue #46)", async () => {
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-student",
      name: "生徒用月表",
      layout: "two_column",
      audience: "student",
      periodScope: "month",
      columns: [
        { id: "col-student-events", sourceKind: "event_category" },
        { id: "col-student-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
      ],
    });
    await actions.setViewMonthNote.run(auth("Editor"), {
      viewId: "view-student",
      month: MONTH,
      lifeGoal: "あいさつを自分からしよう",
      healthGoal: "早寝・早起き・朝ごはん",
    });
    await actions.createEvent.run(auth("Editor"), {
      cookie: COOKIE,
      event: eventPayload({ id: "ev-student", title: "学習発表会", visibility: "student" }),
    });
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-student",
      targetMonth: MONTH,
      versionLabel: "生徒版",
    })) as Record<string, unknown>;
    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    // Two half-month tables stand side by side in one
    // two-column block, and the month's goals head the document.
    expect(html).toContain('class="two-column"');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).toContain('class="month-notes"');
    expect(html).toContain("生活目標");
    expect(html).toContain("あいさつを自分からしよう");
    expect(html).toContain("健康目標");
    expect(html).toContain("早寝・早起き・朝ごはん");
    // The student-facing event stands; nothing staff-shaped does.
    expect(html).toContain("学習発表会");
    expect(html).not.toContain("職員会議");
    expect(html).not.toContain("職員だけのメモ");
    expect(html).not.toContain("先生A");
    expect(html).not.toContain("年休");
  });

  it("a school with a day pattern that has no periods can still publish (Issue #109)", async () => {
    // A stored pattern whose period rows are gone reads back
    // from the platform with an empty periods list (Issue #104);
    // the publication path reads the same day-patterns list, so
    // issuing must not fail on it either, and a day on that
    // pattern keeps its 「Z日課」 mark in the issued document.
    const patterns = fake.masters["day-patterns"];
    if (!patterns) throw new Error("the fake platform seeds day patterns");
    const day = fake.days.find((d) => d["id"] === "day-1");
    if (!day) throw new Error("the fake platform seeds day-1");
    patterns.push({ id: "pattern-empty", code: "Z", name: "時限のない日課", periods: [] });
    day["dayScheduleId"] = "pattern-empty";
    let html: string;
    try {
      const meta = (await actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-staff",
        targetMonth: MONTH,
        versionLabel: "時限なし日課版",
      })) as Record<string, unknown>;
      const doc = (await actions.getPublication.run(auth("Viewer"), {
        id: meta["id"] as string,
      })) as Record<string, unknown>;
      html = doc["documentHtml"] as string;
    } finally {
      day["dayScheduleId"] = null;
      patterns.pop();
    }
    expect(html).toContain("Z日課");
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
    // (PR #79 review, recommendation 2). The alternative the
    // wording names is archiving (Issue #87).
    const error: unknown = await actions.deleteViewDefinition
      .run(auth("Admin"), { id: "view-staff" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 409 });
    expect((error as PlatformRelayError).body).toEqual({
      error: "発行した版があるビューは削除できません。一覧から外すことはできます",
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

  // ---- Issue #48: the version history around the document ----

  const NOV = "2027-11";

  it("the version list filters by month as well as by view (Issue #48)", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: NOV,
      versionLabel: "11月版",
    })) as Record<string, unknown>;
    // The list's meta carries the cancellation stamp (null
    // while live) and never the snapshot.
    expect(meta["cancelledAt"]).toBeNull();
    expect(meta["snapshotJson"]).toBeUndefined();

    const november = (await actions.getPublications.run(auth("Viewer"), {
      viewId: "view-staff",
      targetMonth: NOV,
    })) as Record<string, unknown>[];
    expect(november.map((p) => p["versionLabel"])).toEqual(["11月版"]);

    const october = (await actions.getPublications.run(auth("Viewer"), {
      viewId: "view-staff",
      targetMonth: MONTH,
    })) as Record<string, unknown>[];
    expect(october.length).toBeGreaterThan(0);
    expect(october.every((p) => p["targetMonth"] === MONTH)).toBe(true);

    const all = (await actions.getPublications.run(auth("Viewer"), {
      viewId: "view-staff",
    })) as Record<string, unknown>[];
    expect(all.map((p) => p["versionLabel"])).toContain("11月版");
  });

  it("a version's label and note can be corrected; its document cannot (Issue #48)", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: NOV,
      versionLabel: "直す前の版",
      note: "前のメモ",
    })) as Record<string, unknown>;
    const id = meta["id"] as string;
    const before = (await actions.getPublication.run(auth("Editor"), { id })) as Record<
      string,
      unknown
    >;

    // Editing is the publish permission's, like issuing.
    await expect(
      actions.updatePublication.run(auth("Viewer"), { id, versionLabel: "見るだけの人の訂正" }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    // An update naming neither field is refused.
    await expect(actions.updatePublication.run(auth("Editor"), { id })).rejects.toThrow();

    const updated = (await actions.updatePublication.run(auth("Editor"), {
      id,
      versionLabel: "直した版",
      note: "直したメモ",
    })) as Record<string, unknown>;
    expect(updated["versionLabel"]).toBe("直した版");
    expect(updated["snapshotNote"]).toBe("直したメモ");

    // The stored document is byte for byte what was issued.
    const after = (await actions.getPublication.run(auth("Editor"), { id })) as Record<
      string,
      unknown
    >;
    expect(after["documentHtml"]).toBe(before["documentHtml"]);

    // The note can be cleared by naming it null; the label
    // stays as corrected.
    const cleared = (await actions.updatePublication.run(auth("Editor"), {
      id,
      note: null,
    })) as Record<string, unknown>;
    expect(cleared["snapshotNote"]).toBeNull();
    expect(cleared["versionLabel"]).toBe("直した版");
  });

  it("a cancelled version stays in the list, marked cancelled (Issue #48)", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: NOV,
      versionLabel: "取り消す版",
    })) as Record<string, unknown>;
    const id = meta["id"] as string;

    // Cancellation is the publish permission's.
    await expect(actions.cancelPublication.run(auth("Viewer"), { id })).rejects.toBeInstanceOf(
      AuthAccessError,
    );

    const cancelled = (await actions.cancelPublication.run(auth("Editor"), { id })) as Record<
      string,
      unknown
    >;
    expect(cancelled["cancelledAt"]).not.toBeNull();

    // The record stays in the history, carrying its stamp.
    const list = (await actions.getPublications.run(auth("Viewer"), {
      viewId: "view-staff",
      targetMonth: NOV,
    })) as Record<string, unknown>[];
    const row = list.find((p) => p["id"] === id);
    expect(row).toBeDefined();
    expect(row?.["cancelledAt"]).not.toBeNull();

    // A version is cancelled at most once, and a cancelled
    // version's label and note stand as they were left.
    await expect(actions.cancelPublication.run(auth("Editor"), { id })).rejects.toThrow(
      /すでに取り消されています/,
    );
    await expect(
      actions.updatePublication.run(auth("Editor"), { id, versionLabel: "取り消した版の訂正" }),
    ).rejects.toThrow(/取り消した版/);
  });

  it("the diff between two versions lists only the changed days (Issue #48)", async () => {
    const DAY = "2027-11-10";
    const first = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: NOV,
      versionLabel: "差分第1版",
    })) as Record<string, unknown>;
    // One cell of one day changes; nothing else does.
    await actions.setDailyValue.run(auth("Editor"), {
      date: DAY,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    const second = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: NOV,
      versionLabel: "差分第2版",
    })) as Record<string, unknown>;

    const diff = (await actions.getPublicationDiff.run(auth("Viewer"), {
      id: second["id"] as string,
    })) as Record<string, unknown>;
    expect(diff["comparable"]).toBe(true);
    expect(diff["fromId"]).toBe(first["id"]);
    expect(diff["toId"]).toBe(second["id"]);
    expect(diff["changes"]).toEqual([
      {
        date: DAY,
        cells: [{ columnId: "col-staff-lunch", label: "給食", before: "", after: "○" }],
      },
    ]);
  });

  it("a day-type change alone appears in the diff (Issue #48)", async () => {
    const record: Record_ = {
      revision: 1,
      schoolId: SCHOOL,
      id: "day-nov-15",
      date: "2027-11-15",
      dayType: "class_day",
      dayTypeLabel: null,
      dayScheduleId: null,
      weekdaySwap: null,
      note: null,
    };
    fake.days.push(record);
    try {
      await actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-staff",
        targetMonth: NOV,
        versionLabel: "種別第1版",
      });
      record["dayType"] = "event_day";
      const second = (await actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-staff",
        targetMonth: NOV,
        versionLabel: "種別第2版",
      })) as Record<string, unknown>;
      const diff = (await actions.getPublicationDiff.run(auth("Viewer"), {
        id: second["id"] as string,
      })) as Record<string, unknown>;
      expect(diff["comparable"]).toBe(true);
      expect(diff["changes"]).toEqual([
        {
          date: "2027-11-15",
          dayType: { before: "class_day", after: "event_day" },
          cells: [],
        },
      ]);
    } finally {
      fake.days.splice(fake.days.indexOf(record), 1);
    }
  });

  it("the first version of a month has no previous version to diff against (Issue #48)", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: "2027-12",
      versionLabel: "12月版",
    })) as Record<string, unknown>;
    const diff = (await actions.getPublicationDiff.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    expect(diff).toEqual({
      comparable: true,
      fromId: null,
      toId: meta["id"],
      changes: [],
    });
  });

  it("a version issued before snapshots existed cannot be diffed (Issue #48)", async () => {
    // A legacy row, written straight into the store the way a
    // pre-#48 publication lies in the table: a document, and
    // no structured snapshot.
    const extra = createDb(url as string);
    try {
      await insertPublication(extra.db, SCHOOL, {
        id: "pub-legacy",
        viewDefinitionId: "view-staff",
        targetMonth: "2028-01",
        versionLabel: "旧形式の版",
        publishedAt: new Date("2020-01-05T00:00:00.000Z"),
        publishedBy: "user-40",
        snapshotNote: null,
        printSettings: { paper: "A4", orientation: "landscape", marginMm: 10, fontScale: "medium" },
        documentFormat: "html",
        documentHtml: "<!doctype html><html></html>",
      });
    } finally {
      await extra.queryClient.end();
    }
    const fresh = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-staff",
      targetMonth: "2028-01",
      versionLabel: "新しい版",
    })) as Record<string, unknown>;
    const diff = (await actions.getPublicationDiff.run(auth("Viewer"), {
      id: fresh["id"] as string,
    })) as Record<string, unknown>;
    expect(diff).toEqual({ comparable: false, fromId: "pub-legacy", toId: fresh["id"] });
  });

  // ---- Issue #49: the week, year and calendar layouts issue ----

  it("a week publication covers exactly its span, headed by the span", async () => {
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-week-staff",
      name: "職員用週表",
      layout: "week_rows",
      audience: "staff",
      periodScope: "week",
      layoutParams: { days: 7 },
      columns: [
        { id: "col-week-events", sourceKind: "event_category" },
        { id: "col-week-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        { id: "col-week-note", sourceKind: "daily_item", itemDefinitionId: "item-staff-note" },
      ],
    });
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-week-guardian",
      name: "保護者用週表",
      layout: "week_rows",
      audience: "guardian",
      periodScope: "week",
      columns: [
        { id: "col-week-g-events", sourceKind: "event_category" },
        { id: "col-week-g-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        {
          id: "col-week-g-dismissal",
          sourceKind: "daily_item",
          itemDefinitionId: "item-dismissal",
        },
      ],
    });
    // An event on the day after the span (Monday the 4th): the
    // week's document must not reach it.
    await actions.createEvent.run(auth("Editor"), {
      cookie: COOKIE,
      event: eventPayload({
        id: "ev-outside-week",
        title: "週外の行事",
        startsOn: "2027-10-04",
        endsOn: "2027-10-04",
      }),
    });
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-week-staff",
      targetMonth: "2027-09",
      from: "2027-09-27",
      to: "2027-10-03",
      versionLabel: "週版",
    })) as Record<string, unknown>;
    // The span is recorded on the version; the target month is
    // the month the span starts in.
    expect(meta["rangeFrom"]).toBe("2027-09-27");
    expect(meta["rangeTo"]).toBe("2027-10-03");
    expect(meta["targetMonth"]).toBe("2027-09");

    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    // The header names the span, not a month.
    expect(html).toContain("2027年9月27日〜10月3日 行事予定表");
    // Exactly the span's seven days stand as rows.
    const tbody = (html.split("<tbody>")[1] ?? "").split("</tbody>")[0] as string;
    expect(tbody.match(/<tr/g)).toHaveLength(7);
    expect(html).toContain("運動会");
    expect(html).toContain("職員だけのメモ");
    expect(html).not.toContain("週外の行事");
    // The week table's default paper (Issue #49): A4 landscape.
    expect(html).toContain("size: A4 landscape");

    // The guardian week: the audience rule holds as on paper
    // months — the guardian view's own range holds no
    // staff-only anything.
    const gMeta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-week-guardian",
      targetMonth: "2027-09",
      from: "2027-09-27",
      to: "2027-10-03",
      versionLabel: "保護者週版",
    })) as Record<string, unknown>;
    const gDoc = (await actions.getPublication.run(auth("Viewer"), {
      id: gMeta["id"] as string,
    })) as Record<string, unknown>;
    const gHtml = gDoc["documentHtml"] as string;
    expect(gHtml).toContain("運動会");
    expect(gHtml).toContain("1～3年 14:30");
    expect(gHtml).not.toContain("職員会議");
    expect(gHtml).not.toContain("職員だけのメモ");
    expect(gHtml).not.toContain("先生A");
  });

  it("a 14-day week span issues too, and reaches its second week", async () => {
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-week-staff",
      targetMonth: "2027-09",
      from: "2027-09-27",
      to: "2027-10-10",
      versionLabel: "2週間版",
    })) as Record<string, unknown>;
    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    const tbody = (html.split("<tbody>")[1] ?? "").split("</tbody>")[0] as string;
    expect(tbody.match(/<tr/g)).toHaveLength(14);
    expect(html).toContain("週外の行事");
  });

  it("week versions diff against the previous issue of the same week", async () => {
    const v1 = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-week-staff",
      targetMonth: "2027-10",
      from: "2027-10-11",
      to: "2027-10-17",
      versionLabel: "週第1版",
    })) as Record<string, unknown>;
    await actions.setDailyValue.run(auth("Editor"), {
      date: "2027-10-13",
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    const v2 = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-week-staff",
      targetMonth: "2027-10",
      from: "2027-10-11",
      to: "2027-10-17",
      versionLabel: "週第2版",
    })) as Record<string, unknown>;
    const diff = (await actions.getPublicationDiff.run(auth("Viewer"), {
      id: v2["id"] as string,
    })) as Record<string, unknown>;
    expect(diff["comparable"]).toBe(true);
    expect(diff["fromId"]).toBe(v1["id"]);
    // Only the changed day is listed — the period grouping
    // reaches beyond months.
    expect(diff["changes"]).toEqual([
      {
        date: "2027-10-13",
        cells: [{ columnId: "col-week-lunch", label: "給食", before: "", after: "○" }],
      },
    ]);
  });

  it("a year publication spans the school year with all twelve months", async () => {
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-year-staff",
      name: "職員用年間表",
      layout: "year_columns",
      audience: "staff",
      periodScope: "year",
      columns: [
        { id: "col-year-events", sourceKind: "event_category" },
        { id: "col-year-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        { id: "col-year-note", sourceKind: "daily_item", itemDefinitionId: "item-staff-note" },
      ],
    });
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-year-guardian",
      name: "保護者用年間表",
      layout: "year_columns",
      audience: "guardian",
      periodScope: "year",
      columns: [
        { id: "col-year-g-events", sourceKind: "event_category" },
        { id: "col-year-g-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
      ],
    });
    // A known entry in the year's last month (March).
    await actions.createEvent.run(auth("Editor"), {
      cookie: COOKIE,
      event: eventPayload({
        id: "ev-graduation",
        title: "卒業式",
        startsOn: "2028-03-15",
        endsOn: "2028-03-15",
      }),
    });
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-year-staff",
      targetMonth: "2027-04",
      from: "2027-04-01",
      to: "2028-03-31",
      versionLabel: "年度版",
    })) as Record<string, unknown>;
    expect(meta["rangeFrom"]).toBe("2027-04-01");
    expect(meta["rangeTo"]).toBe("2028-03-31");
    expect((meta["printSettings"] as Record<string, unknown>)["paper"]).toBe("A3");

    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    expect(html).toContain("2027年度 行事予定表");
    // All twelve month blocks, April through March.
    for (const m of [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]) {
      expect(html).toContain(`>${m}月</th>`);
    }
    expect(html).toContain("卒業式");
    expect(html).toContain("運動会");
    expect(html).toContain("職員だけのメモ");
    // The year table's default paper (Issue #49): A3 landscape.
    expect(html).toContain("size: A3 landscape");

    const gMeta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-year-guardian",
      targetMonth: "2027-04",
      from: "2027-04-01",
      to: "2028-03-31",
      versionLabel: "保護者年度版",
    })) as Record<string, unknown>;
    const gDoc = (await actions.getPublication.run(auth("Viewer"), {
      id: gMeta["id"] as string,
    })) as Record<string, unknown>;
    const gHtml = gDoc["documentHtml"] as string;
    expect(gHtml).toContain("卒業式");
    expect(gHtml).not.toContain("職員会議");
    expect(gHtml).not.toContain("職員だけのメモ");
    expect(gHtml).not.toContain("先生A");
  });

  it("a calendar publication prints every entry of a crowded day, uncapped", async () => {
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-calendar-staff",
      name: "職員用カレンダー",
      layout: "calendar_grid",
      audience: "staff",
      periodScope: "month",
      columns: [
        { id: "col-cal-events", sourceKind: "event_category" },
        { id: "col-cal-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        { id: "col-cal-note", sourceKind: "daily_item", itemDefinitionId: "item-staff-note" },
      ],
    });
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-calendar-guardian",
      name: "保護者用カレンダー",
      layout: "calendar_grid",
      audience: "guardian",
      periodScope: "month",
      columns: [
        { id: "col-cal-g-events", sourceKind: "event_category" },
        { id: "col-cal-g-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
      ],
    });
    // Four events and an absence on one day: five entries,
    // two more than the screen grid's cell cap of three. The
    // absence is the entry a column-shaped reading of the
    // calendar would lose — the view's columns carry no
    // absence of their own, yet the grid's cells count the
    // day's absences among their lines.
    const crowded = ["校内研修", "避難訓練", "委員会活動", "PTA総会"];
    for (const [i, title] of crowded.entries()) {
      await actions.createEvent.run(auth("Editor"), {
        cookie: COOKIE,
        event: eventPayload({
          id: `ev-cal-${i + 1}`,
          title,
          startsOn: "2027-10-05",
          endsOn: "2027-10-05",
        }),
      });
    }
    await actions.createAbsence.run(auth("Editor"), {
      cookie: COOKIE,
      absence: {
        id: "abs-cal-crowded",
        staffId: "teacher-a2",
        fromDate: "2027-10-05",
        toDate: "2027-10-05",
        time: { kind: "all_day" },
        kind: "leave",
        certainty: "confirmed",
        purpose: null,
        note: null,
        subdivisionKey: "annual",
      },
    });
    const meta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-calendar-staff",
      targetMonth: MONTH,
      versionLabel: "カレンダー版",
    })) as Record<string, unknown>;
    // No span named: the span defaults to the target month, and
    // is recorded like any other.
    expect(meta["rangeFrom"]).toBe("2027-10-01");
    expect(meta["rangeTo"]).toBe("2027-10-31");
    expect((meta["printSettings"] as Record<string, unknown>)["orientation"]).toBe("portrait");

    const doc = (await actions.getPublication.run(auth("Viewer"), {
      id: meta["id"] as string,
    })) as Record<string, unknown>;
    const html = doc["documentHtml"] as string;
    // The calendar's default paper (Issue #49): A4 portrait.
    expect(html).toContain("size: A4 portrait");
    // Every entry of the crowded day prints — including the
    // ones the screen cell caps away — and no overflow count
    // appears anywhere.
    for (const title of crowded) expect(html).toContain(title);
    // The crowded day's absence prints as its own line too:
    // the day's lines run events-then-absences, so the leave
    // stands past the cap, with the fourth event.
    expect(html).toContain("先生B（年休）");
    expect(html).not.toMatch(/他\d+件/);
    // The month's staff content stands in its cells — the
    // staff-only event, the leave, and the compact lunch line
    // the grid shows (「給食：○」, the item's name ahead of its
    // symbol).
    expect(html).toContain("職員会議");
    expect(html).toContain("先生A（年休）");
    expect(html).toContain("給食：○");
    // The staff note is a text daily value: the grid reads
    // those in the day detail, not the cell, so the calendar
    // document does not print it either.
    expect(html).not.toContain("職員だけのメモ");

    const gMeta = (await actions.createPublication.run(auth("Editor"), {
      cookie: COOKIE,
      viewId: "view-calendar-guardian",
      targetMonth: MONTH,
      versionLabel: "保護者カレンダー版",
    })) as Record<string, unknown>;
    const gDoc = (await actions.getPublication.run(auth("Viewer"), {
      id: gMeta["id"] as string,
    })) as Record<string, unknown>;
    const gHtml = gDoc["documentHtml"] as string;
    expect(gHtml).toContain("PTA総会");
    expect(gHtml).not.toContain("職員会議");
    expect(gHtml).not.toContain("職員だけのメモ");
    expect(gHtml).not.toContain("先生A");
    expect(gHtml).not.toMatch(/他\d+件/);
  });

  it("spans that break their layout's rule are refused", async () => {
    // A month table with a span that is not its month.
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-staff",
        targetMonth: MONTH,
        from: "2027-10-04",
        to: "2027-10-10",
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/月表の発行期間は/);
    // A year table with a month's span.
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-year-staff",
        targetMonth: MONTH,
        from: "2027-10-01",
        to: "2027-10-31",
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/年間表の発行期間は/);
    // A week table with five days.
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-week-staff",
        targetMonth: MONTH,
        from: "2027-10-11",
        to: "2027-10-15",
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/週表の発行期間は/);
    // A target month that is not the span's first month.
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-week-staff",
        targetMonth: MONTH,
        from: "2027-09-27",
        to: "2027-10-03",
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/対象月は発行期間の開始月/);
    // The screen-only layouts do not issue at all.
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-timeline-staff",
      name: "職員用タイムライン",
      layout: "week_timeline",
      audience: "staff",
      periodScope: "week",
      columns: [{ id: "col-tl-events", sourceKind: "event_category" }],
    });
    await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-transposed-staff",
      name: "職員用転置表",
      layout: "transposed",
      audience: "staff",
      periodScope: "month",
      columns: [{ id: "col-tr-events", sourceKind: "event_category" }],
    });
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-timeline-staff",
        targetMonth: MONTH,
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/発行の対象外/);
    await expect(
      actions.createPublication.run(auth("Editor"), {
        cookie: COOKIE,
        viewId: "view-transposed-staff",
        targetMonth: MONTH,
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/発行の対象外/);
  });
});
