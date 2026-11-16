import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthAccessError,
  type AuthContext,
  type Role,
  type SecureAction,
} from "@school-manage/platform-client";
import {
  eventInRange,
  filterVisible,
  forAudience,
  type Audience,
} from "@school-manage/calendar-types";
import { createScheduleActions, createSchedulePublicActions } from "../src/composition.js";
import { createDb, type Db } from "../src/db/client.js";
import { schoolCache } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPlatformApiClient, PlatformRelayError } from "../src/platformClient.js";
import { hashPublicToken } from "../src/publicViews/actions.js";
import { createPublicPlatformClient } from "../src/publicViews/publicPlatform.js";
import * as tokensStore from "../src/db/publicTokens.js";
import * as schoolCacheStore from "../src/db/schoolCache.js";

// Public viewing tests (Issue #41): a per-view token opens the
// view to readers with no account, and nothing else. The fake
// platform shapes its answers the way the real one does (the
// audience filter on events), and the public layer's own shaping
// is judged on top of it: what the public bundle must never carry
// (duties, names, assignees, absences) is absent even though the
// school's data holds all of it for the staff view of the same day.
//
// Since Issue #82 the public actions read through the platform's
// public-read path, with the service credential and the school and
// audience named — the fake serves that path the way the real
// platform does (credential checked, staff audience refused, the
// public response shapes), and the member paths stay for the
// staff-side actions the setup drives.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=test-token";
const PUBLIC_TOKEN = "public-read-test-token";
const SCHOOL = "school-41";
const DATE = "2027-10-02";
const FROM = "2027-10-01";
const TO = "2027-10-31";

type Record_ = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function auth(role: Role): AuthContext {
  return {
    userId: "user-41",
    schoolId: SCHOOL,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

// The public bootstrap reads the holidays of the school year it
// is asked in, so the fixture's holiday stands in the current
// school year (the range tests' own month, 2027-10, is a different
// year and would be filtered out by the fake's range check).
const NOW = new Date();
const SCHOOL_YEAR = NOW.getMonth() + 1 >= 4 ? NOW.getFullYear() : NOW.getFullYear() - 1;
const HOLIDAY_DATE = `${SCHOOL_YEAR}-11-03`;

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
      date: HOLIDAY_DATE,
      name: "文化の日",
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
  /** Every request the fake received, as "METHOD /path" (no query),
   *  so a test can judge which paths a layer actually called. */
  requests: string[] = [];
  /** When true, /auth/me answers 503: for the school-cache
   *  sync at token issuance, the platform does not answer
   *  (Issue #41 re-review). */
  failMe = false;

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = String(input).replace("http://platform.test", "");
    const [path, query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record_) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.requests.push(`${method} ${path}`);
    return Promise.resolve(this.route(method, path as string, params, body, headers));
  };

  /** The public shape of a record, as the real platform's
   *  public-read path answers it: no school id, no revision, no
   *  creator / updater stamps. */
  private publicShape(record: Record_): Record_ {
    const shaped = { ...record };
    delete shaped["schoolId"];
    delete shaped["revision"];
    delete shaped["createdBy"];
    delete shaped["updatedBy"];
    delete shaped["updatedVia"];
    return shaped;
  }

  /** The platform's public-read path (Issue #82), as the real one
   *  serves it: the service credential is checked first, the
   *  audience must be a public one, and the school is the one the
   *  request names. Returns null when the path is not this path's. */
  private publicReadRoute(
    method: string,
    path: string,
    params: URLSearchParams,
    headers: Record<string, string>,
  ): Response | null {
    if (!path.startsWith("/platform/api/v1/public-read/")) return null;
    if (headers["authorization"] !== `Bearer ${PUBLIC_TOKEN}`) {
      return jsonResponse(401, { error: "認証が必要です" });
    }
    const audience = params.get("audience");
    if (audience !== "guardian" && audience !== "student" && audience !== "public") {
      return jsonResponse(400, { error: "入力が正しくありません" });
    }
    if (params.get("schoolId") !== SCHOOL) {
      return jsonResponse(404, { error: "見つかりません" });
    }
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (method === "GET" && path === "/platform/api/v1/public-read/school") {
      return jsonResponse(200, { schoolId: SCHOOL, name: "テスト学校", slug: "test" });
    }
    if (method === "GET" && path === "/platform/api/v1/public-read/calendar/days") {
      return jsonResponse(200, {
        items: this.days
          .filter((d) => (d.date as string) >= from && (d.date as string) <= to)
          .map((d) => this.publicShape(d)),
      });
    }
    if (method === "GET" && path === "/platform/api/v1/public-read/calendar/holidays") {
      return jsonResponse(200, {
        items: this.holidays
          .filter((h) => (h.date as string) >= from && (h.date as string) <= to)
          .map((h) => this.publicShape(h)),
      });
    }
    if (method === "GET" && path === "/platform/api/v1/public-read/calendar/events") {
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
      const items = visible.map((event) =>
        this.publicShape(forAudience(event as { assignees: unknown[] }, audience) as Record_),
      );
      return jsonResponse(200, { items });
    }
    if (method === "GET" && path === "/platform/api/v1/public-read/masters/grades") {
      return jsonResponse(200, { items: this.masters["grades"] ?? [] });
    }
    return jsonResponse(404, { error: "見つかりません" });
  }

  private route(
    method: string,
    path: string,
    params: URLSearchParams,
    body: Record_ | null,
    headers: Record<string, string> = {},
  ): Response {
    const publicRead = this.publicReadRoute(method, path, params, headers);
    if (publicRead) return publicRead;
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
      if (this.failMe) return jsonResponse(503, { error: "基盤が応答しません" });
      return jsonResponse(200, {
        user: { id: "user-41", name: "先生A" },
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
  createdBy: "user-41",
  updatedBy: "user-41",
  ...overrides,
});

describe.skipIf(!url)("public viewing (Issue #41)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: Db;
  let actions: ReturnType<typeof createScheduleActions>;
  let publicActions: ReturnType<typeof createSchedulePublicActions>;
  let fake: FakePlatform;
  let guardianToken = "";
  let guardianTokenId = "";

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
    fake = new FakePlatform();
    const client = createPlatformApiClient({
      baseUrl: "http://platform.test",
      fetchImpl: fake.fetch,
    });
    actions = createScheduleActions(db, client, COOKIE);
    publicActions = createSchedulePublicActions(
      db,
      createPublicPlatformClient({
        baseUrl: "http://platform.test",
        serviceToken: PUBLIC_TOKEN,
        fetchImpl: fake.fetch,
      }),
    );
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
      id: "item-contact",
      key: "contact",
      name: "連絡担当",
      valueType: "person",
      granularity: "day",
      defaultVisibility: "guardian",
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
      columns: [
        { id: "col-guardian-events", sourceKind: "event_category" },
        { id: "col-guardian-lunch", sourceKind: "daily_item", itemDefinitionId: "item-lunch" },
        {
          id: "col-guardian-dismissal",
          sourceKind: "daily_item",
          itemDefinitionId: "item-dismissal",
        },
        { id: "col-guardian-contact", sourceKind: "daily_item", itemDefinitionId: "item-contact" },
      ],
    });

    await actions.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    await actions.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-dismissal",
      target: { axis: "grade", id: "grade-1" },
      value: "14:30",
    });
    await actions.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-staff-note",
      value: "職員だけのメモ",
    });
    await actions.setDailyValue.run(editorA, {
      date: DATE,
      itemDefinitionId: "item-contact",
      value: "teacher-a1",
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
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("token management is school.admin's, on the server", async () => {
    await expect(
      actions.createPublicViewToken.run(auth("Editor"), { viewId: "view-guardian" }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    await expect(
      actions.createPublicViewToken.run(auth("Viewer"), { viewId: "view-guardian" }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    await expect(actions.getPublicViewTokens.run(auth("Editor"), {})).rejects.toBeInstanceOf(
      AuthAccessError,
    );
    await expect(
      actions.revokePublicViewToken.run(auth("Editor"), { id: "whatever" }),
    ).rejects.toBeInstanceOf(AuthAccessError);
  });

  it("a staff view cannot be issued a token", async () => {
    const error = await actions.createPublicViewToken
      .run(auth("Admin"), { viewId: "view-staff" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect((error as PlatformRelayError).status).toBe(400);
    expect((error as PlatformRelayError).body).toEqual({
      error: "職員用ビューには公開URLを発行できません",
    });
    // And nothing was stored for the staff view.
    const listed = (await actions.getPublicViewTokens.run(auth("Admin"), {
      viewId: "view-staff",
    })) as Record_[];
    expect(listed).toEqual([]);
  });

  it("issuing returns the raw token once; the store holds only its hash", async () => {
    const issued = (await actions.createPublicViewToken.run(auth("Admin"), {
      viewId: "view-guardian",
      cookie: COOKIE,
    })) as Record_;
    guardianToken = issued["token"] as string;
    guardianTokenId = issued["id"] as string;
    expect(typeof guardianToken).toBe("string");
    expect(guardianToken.length).toBeGreaterThanOrEqual(40);
    expect(issued["tokenHash"]).toBe(hashPublicToken(guardianToken));
    expect(issued["tokenHash"]).not.toBe(guardianToken);
    expect(issued["viewDefinitionId"]).toBe("view-guardian");
    expect(issued["revokedAt"]).toBeNull();

    // The list — the only other read of the rows — has no raw token.
    const listed = (await actions.getPublicViewTokens.run(auth("Admin"), {
      viewId: "view-guardian",
    })) as Record_[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.["token"]).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(guardianToken);

    // The stored row itself: hash only, and it finds by that hash.
    const stored = await tokensStore.findPublicViewTokenByHash(db, hashPublicToken(guardianToken));
    expect(stored?.id).toBe(guardianTokenId);
    expect(JSON.stringify(stored)).not.toContain(guardianToken);

    // The issuance also synced the school cache from the
    // platform (the caller's cookie rode along): the school's
    // slug — "test", as the fake's /auth/me reports it — now
    // resolves to this school, which is what the public reads
    // below check their URL's slug against.
    expect(await schoolCacheStore.findSchoolIdBySlug(db, "test")).toBe(SCHOOL);
  });

  it("the public bootstrap carries the school, the view, its items, axes and holidays only", async () => {
    const boot = (await publicActions.getPublicBootstrap.run({
      token: guardianToken,
      slug: "test",
    })) as Record_;
    expect((boot["school"] as Record_)["name"]).toBe("テスト学校");
    const view = boot["view"] as Record_;
    expect(view["id"]).toBe("view-guardian");
    const columns = view["columns"] as Record_[];
    expect(columns.map((c) => c["id"]).sort()).toEqual([
      "col-guardian-contact",
      "col-guardian-dismissal",
      "col-guardian-events",
      "col-guardian-lunch",
    ]);
    const items = boot["itemDefinitions"] as Record_[];
    expect(items.map((i) => i["id"]).sort()).toEqual([
      "item-contact",
      "item-dismissal",
      "item-lunch",
    ]);
    // The grade axis's members are there to label per-grade
    // values; the staff master is nowhere in the payload.
    const grades = boot["grades"] as Record_[];
    expect(grades.map((g) => g["name"])).toEqual(["1年", "2年", "3年"]);
    const holidays = boot["holidays"] as Record_[];
    expect(holidays.some((h) => h["name"] === "文化の日")).toBe(true);
    const text = JSON.stringify(boot);
    expect(text).not.toContain("先生A");
    expect(text).not.toContain("teacher-a1");
    expect(text).not.toContain("staff");
  });

  it("the public range has the day's public face and nothing staff-shaped", async () => {
    const range = (await publicActions.getPublicRange.run({
      token: guardianToken,
      slug: "test",
      from: FROM,
      to: TO,
    })) as unknown as Record_;
    const days = range["days"] as Record_[];
    const day = days.find((d) => d["date"] === DATE) as Record_;
    const events = day["events"] as Record_[];
    expect(events.map((e) => e["title"])).toEqual(["運動会"]);
    // The event is there, its assignees are not: no person ids,
    // no free-text names, no creator / updater ids.
    expect(events[0]?.["assignees"]).toEqual([]);
    expect(events[0]?.["createdBy"]).toBeUndefined();
    expect(events[0]?.["updatedBy"]).toBeUndefined();
    // No absences, no duties, no conflicts — by construction.
    expect(day["absences"]).toEqual([]);
    expect(day["dutyAssignments"]).toEqual([]);
    expect(range["conflicts"]).toEqual([]);
    // The day's public daily values are there; the staff-only
    // item's value is not, and a person value's id is stripped.
    const values = day["dailyValues"] as Record_[];
    const itemIds = values.map((v) => v["itemDefinitionId"]);
    expect(itemIds).toContain("item-lunch");
    expect(itemIds).toContain("item-dismissal");
    expect(itemIds).not.toContain("item-staff-note");
    const contact = values.find((v) => v["itemDefinitionId"] === "item-contact") as Record_;
    expect(contact["valuePersonId"]).toBeNull();
    // The values' creator / updater stamps are person ids too:
    // they do not ride along (Issue #82).
    const lunch = values.find((v) => v["itemDefinitionId"] === "item-lunch") as Record_;
    expect(lunch["createdBy"]).toBeUndefined();
    expect(lunch["updatedBy"]).toBeUndefined();
    // Nothing in the whole payload names a person or a duty.
    const text = JSON.stringify(range);
    expect(text).not.toContain("先生A");
    expect(text).not.toContain("teacher-a1");
    expect(text).not.toContain("user-41");
    expect(text).not.toContain("職員会議");
    expect(text).not.toContain("職員だけのメモ");
    expect(text).not.toContain("日直");
    expect(text).not.toContain("年休");
  });

  it("the public actions read through the public-read path and never call /auth/me", async () => {
    // Issue #82: the school's name, the holidays, the grades and
    // the range's platform reads all go to the public-read path,
    // with the service credential — the session-shaped member
    // paths (and /auth/me above all, which a session-less read
    // cannot answer) are not called at all.
    fake.requests.length = 0;
    await publicActions.getPublicBootstrap.run({ token: guardianToken, slug: "test" });
    await publicActions.getPublicRange.run({
      token: guardianToken,
      slug: "test",
      from: FROM,
      to: TO,
    });
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const entry of fake.requests) {
      expect(entry).toContain("/platform/api/v1/public-read/");
    }
    expect(fake.requests.some((entry) => entry.includes("/auth/me"))).toBe(false);
    expect(fake.requests.some((entry) => entry.includes("/calendar/absences"))).toBe(false);
  });

  it("an unknown token is a 404 and a revoked token is a 401", async () => {
    const unknown = await publicActions.getPublicRange
      .run({ token: "no-such-token", slug: "test", from: FROM, to: TO })
      .catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(PlatformRelayError);
    expect((unknown as PlatformRelayError).status).toBe(404);

    const issued = (await actions.createPublicViewToken.run(auth("Admin"), {
      viewId: "view-guardian",
    })) as Record_;
    const revoked = (await actions.revokePublicViewToken.run(auth("Admin"), {
      id: issued["id"] as string,
    })) as Record_;
    expect(revoked["revokedAt"]).not.toBeNull();

    const dead = await publicActions.getPublicBootstrap
      .run({ token: issued["token"] as string, slug: "test" })
      .catch((e: unknown) => e);
    expect(dead).toBeInstanceOf(AuthAccessError);
    expect((dead as AuthAccessError).status).toBe(401);

    // The revocation is on the record the list shows.
    const listed = (await actions.getPublicViewTokens.run(auth("Admin"), {
      viewId: "view-guardian",
    })) as Record_[];
    const row = listed.find((t) => t["id"] === issued["id"]) as Record_;
    expect(row["revokedAt"]).not.toBeNull();
    expect(row["createdBy"]).toBe("user-41");
  });

  it("a token answers only under its own school's slug", async () => {
    // Another school's slug on record (its own issuance synced
    // it, in its own time): this school's token under that slug
    // is a 404 — the URL as a whole names nothing here, and the
    // answer does not say which half missed.
    await schoolCacheStore.upsertSchoolCache(db, {
      schoolId: "school-42",
      name: "別の学校",
      slug: "other-school",
    });
    const wrongSchool = await publicActions.getPublicRange
      .run({ token: guardianToken, slug: "other-school", from: FROM, to: TO })
      .catch((e: unknown) => e);
    expect(wrongSchool).toBeInstanceOf(PlatformRelayError);
    expect((wrongSchool as PlatformRelayError).status).toBe(404);

    // A slug no school has on record is the same 404.
    const unknownSlug = await publicActions.getPublicBootstrap
      .run({ token: guardianToken, slug: "no-such-school" })
      .catch((e: unknown) => e);
    expect(unknownSlug).toBeInstanceOf(PlatformRelayError);
    expect((unknownSlug as PlatformRelayError).status).toBe(404);

    // And the token still answers under its own school's slug.
    const own = (await publicActions.getPublicBootstrap.run({
      token: guardianToken,
      slug: "test",
    })) as Record_;
    expect((own["school"] as Record_)["id"]).toBe(SCHOOL);
  });

  it("issuing for a missing view and revoking a missing token are 404s, not 500s", async () => {
    const noView = await actions.createPublicViewToken
      .run(auth("Admin"), { viewId: "view-missing" })
      .catch((e: unknown) => e);
    expect(noView).toBeInstanceOf(PlatformRelayError);
    expect((noView as PlatformRelayError).status).toBe(404);

    const noToken = await actions.revokePublicViewToken
      .run(auth("Admin"), { id: "no-such-token-id" })
      .catch((e: unknown) => e);
    expect(noToken).toBeInstanceOf(PlatformRelayError);
    expect((noToken as PlatformRelayError).status).toBe(404);
  });

  it("issuing stands or falls on the school cache row when the sync cannot refresh it", async () => {
    // The public route resolves a URL's slug through the school
    // cache, so a token for a school with no cache row would
    // answer 404 forever (Issue #41 re-review). The sync is
    // best-effort, but issuance judges the row afterwards.
    const downFake = new FakePlatform();
    downFake.failMe = true;
    const downActions = createScheduleActions(
      db,
      createPlatformApiClient({ baseUrl: "http://platform.test", fetchImpl: downFake.fetch }),
      COOKIE,
    );
    const countTokens = async () =>
      (
        (await actions.getPublicViewTokens.run(auth("Admin"), {
          viewId: "view-guardian",
        })) as Record_[]
      ).length;

    // Sync failing and no row on record: issuance refuses with
    // the reason, and stores nothing.
    await db.delete(schoolCache).where(eq(schoolCache.schoolId, SCHOOL));
    const before = await countTokens();
    const refused = await downActions.createPublicViewToken
      .run(auth("Admin"), { viewId: "view-guardian", cookie: COOKIE })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PlatformRelayError);
    expect((refused as PlatformRelayError).status).toBe(400);
    expect((refused as PlatformRelayError).body).toEqual({
      error: "学校の情報を確認できませんでした。もう一度お試しください",
    });
    expect(await countTokens()).toBe(before);
    expect(await schoolCacheStore.findSchoolIdBySlug(db, "test")).toBeNull();

    // Sync still failing, but a row is on record (an earlier
    // sync put it there): the URL can resolve its slug, so
    // issuance stands.
    await schoolCacheStore.upsertSchoolCache(db, {
      schoolId: SCHOOL,
      name: "テスト学校",
      slug: "test",
    });
    const issued = (await downActions.createPublicViewToken.run(auth("Admin"), {
      viewId: "view-guardian",
      cookie: COOKIE,
    })) as Record_;
    expect(typeof issued["token"]).toBe("string");

    // And with the platform answering again, a missing row is
    // no obstacle: the sync fills it and issuance proceeds as
    // it always did.
    await db.delete(schoolCache).where(eq(schoolCache.schoolId, SCHOOL));
    const reissued = (await actions.createPublicViewToken.run(auth("Admin"), {
      viewId: "view-guardian",
      cookie: COOKIE,
    })) as Record_;
    expect(typeof reissued["token"]).toBe("string");
    expect(await schoolCacheStore.findSchoolIdBySlug(db, "test")).toBe(SCHOOL);
  });

  it("the public actions cannot be registered where secure actions are required", () => {
    // A PublicAction takes no AuthContext: putting the public
    // registry where a SecureAction registry is required is a
    // compile error, which is what keeps a write (every write is
    // a SecureAction) out of the public route's reach.
    // @ts-expect-error a public action is not a SecureAction
    const asSecure: Record<string, SecureAction<unknown, unknown>> = publicActions;
    void asSecure;
    // And the public registry simply has no write actions to call.
    // @ts-expect-error the public registry has no createEvent
    void publicActions.createEvent;
  });
});
