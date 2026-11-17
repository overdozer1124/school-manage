import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CalendarEventRecord } from "@school-manage/calendar-types";
import { createApp } from "../src/app.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { createDayStore, createHolidayStore } from "../src/db/days.js";
import { createEventStore, type EventStore } from "../src/db/events.js";
import { createMasterStore } from "../src/db/masters.js";
import { runMigrations } from "../src/db/migrate.js";
import { grades, schools, staffMembers } from "../src/db/schema.js";

// Public-read tests (Issue #82): the platform's session-less read
// path for the public viewing pages. The caller is the schedule
// server, authenticated by the service credential — no credential
// or a wrong one is a 401; the audience must be a public one
// (staff is refused); and what comes back is the public shape for
// the named school alone: no duties, no people, no assignees, no
// leave, no staff_only events, and no other school's data. Runs
// only when PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const TOKEN = "public-read-test-token";
const BASE = "/platform/api/v1/public-read";
const NOVEMBER = "from=2026-11-01&to=2026-11-30";
const DATE = "2026-11-10";

type Json = Record<string, unknown> & { items?: Json[]; error?: string };

describe.skipIf(!url)("public read path", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let server: Server;
  let baseUrl: string;
  let eventStore: EventStore;

  async function api(
    path: string,
    options: { token?: string | null } = {},
  ): Promise<{ status: number; json: Json }> {
    const token = options.token === undefined ? TOKEN : options.token;
    const res = await fetch(`${baseUrl}${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    return { status: res.status, json };
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

    await db.insert(schools).values([
      { schoolId: A, slug: "school-a", name: "A校" },
      { schoolId: B, slug: "school-b", name: "B校" },
    ]);
    // The staff member the public event names as an assignee and
    // as a staff-axis target (the store checks references; the
    // public shape must then shed both).
    await db.insert(staffMembers).values([
      {
        schoolId: A,
        id: "staff-1",
        name: "山田太郎",
        shortName: "山田",
        sortOrder: 1,
        active: true,
        personId: null,
        revision: 1,
        updatedBy: "person-a",
        updatedVia: "platform",
      },
    ]);
    // Grades of both schools, written directly (the masters API is
    // covered by its own tests).
    await db.insert(grades).values([
      {
        schoolId: A,
        id: "grade-a1",
        name: "1年",
        sortOrder: 1,
        stage: null,
        revision: 1,
        updatedBy: "person-a",
        updatedVia: "platform",
      },
      {
        schoolId: B,
        id: "grade-b1",
        name: "B校1年",
        sortOrder: 1,
        stage: null,
        revision: 1,
        updatedBy: "person-b",
        updatedVia: "platform",
      },
    ]);

    const actor = { userId: "person-a", via: "platform" as const };
    const dayStore = createDayStore(db);
    const holidayStore = createHolidayStore(db);
    eventStore = createEventStore(db);
    await dayStore.create(
      {
        schoolId: A,
        id: "day-a",
        date: DATE,
        dayType: "event_day",
        dayTypeLabel: null,
        dayScheduleId: null,
        weekdaySwap: null,
        note: null,
      },
      actor,
    );
    await dayStore.create(
      {
        schoolId: B,
        id: "day-b",
        date: DATE,
        dayType: "closed_day",
        dayTypeLabel: null,
        dayScheduleId: null,
        weekdaySwap: null,
        note: null,
      },
      actor,
    );
    await holidayStore.create(
      { schoolId: A, id: "hol-a", date: DATE, name: "A校の休日", kind: "school_closed_day" },
      actor,
    );
    await holidayStore.create(
      { schoolId: B, id: "hol-b", date: DATE, name: "B校の休日", kind: "school_closed_day" },
      actor,
    );
    // A guardian-visible event carrying everything the public shape
    // must shed: a staff assignee, a free-text assignee name and a
    // staff-axis target.
    await eventStore.create(
      {
        schoolId: A,
        id: "ev-public",
        title: "運動会",
        kind: "event",
        kindLabel: null,
        datePrecision: "day",
        startsOn: DATE,
        endsOn: DATE,
        time: null,
        locationId: null,
        locationText: "校庭",
        description: null,
        certainty: "confirmed",
        visibility: "guardian",
        targets: [
          { axis: "grade", id: "grade-a1" },
          { axis: "staff", id: "staff-1" },
        ],
        impacts: [],
        assignees: [
          { kind: "staff", staffId: "staff-1", role: "担当" },
          { kind: "free_text", name: "外部講師", role: "引率" },
        ],
      },
      actor,
    );
    await eventStore.create(
      {
        schoolId: A,
        id: "ev-staff-only",
        title: "職員会議",
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
        visibility: "staff_only",
        targets: [],
        impacts: [],
        assignees: [],
      },
      actor,
    );
    await eventStore.create(
      {
        schoolId: B,
        id: "ev-b",
        title: "B校の行事",
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
        assignees: [],
      },
      actor,
    );

    const app = createApp({
      publicRead: {
        authStore: createAuthStore(db),
        dayStore,
        holidayStore,
        eventStore,
        masterStore: createMasterStore(db),
        serviceToken: TOKEN,
      },
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    server.close();
    await queryClient.end();
  });

  it("a request without the service credential, or with a wrong one, is a 401", async () => {
    const path = `${BASE}/school?schoolId=${A}&audience=guardian`;
    expect((await api(path, { token: null })).status).toBe(401);
    expect((await api(path, { token: "wrong-token" })).status).toBe(401);
    // A member-shaped credential is not the service credential:
    // a session cookie alone does not open this path either.
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { cookie: "platform_session=whatever" },
    });
    expect(res.status).toBe(401);
  });

  it("naming staff as the audience is refused", async () => {
    const staff = await api(`${BASE}/calendar/events?schoolId=${A}&audience=staff&${NOVEMBER}`);
    expect(staff.status).toBe(400);
    const missing = await api(`${BASE}/calendar/events?schoolId=${A}&${NOVEMBER}`);
    expect(missing.status).toBe(400);
    const bogus = await api(`${BASE}/calendar/events?schoolId=${A}&audience=nobody&${NOVEMBER}`);
    expect(bogus.status).toBe(400);
  });

  it("the school is named by slug or by id; an unknown school is a 404", async () => {
    const bySlug = await api(`${BASE}/school?slug=school-a&audience=guardian`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.json).toEqual({ schoolId: A, name: "A校", slug: "school-a" });
    const byId = await api(`${BASE}/school?schoolId=${B}&audience=public`);
    expect(byId.status).toBe(200);
    expect(byId.json["name"]).toBe("B校");
    expect((await api(`${BASE}/school?slug=no-such&audience=guardian`)).status).toBe(404);
    expect((await api(`${BASE}/school?audience=guardian`)).status).toBe(400);
  });

  it("events come back in the public shape: no assignees, no staff targets, no stamps", async () => {
    const { status, json } = await api(
      `${BASE}/calendar/events?schoolId=${A}&audience=guardian&${NOVEMBER}`,
    );
    expect(status).toBe(200);
    const items = json.items ?? [];
    // The staff_only event is not there at all, and neither is
    // the other school's event.
    expect(items.map((item) => item["id"])).toEqual(["ev-public"]);
    const event = items[0] as Json;
    expect(event["title"]).toBe("運動会");
    expect(event["assignees"]).toEqual([]);
    expect(event["targets"]).toEqual([{ axis: "grade", id: "grade-a1" }]);
    // No person ids or internal stamps anywhere in the shape.
    for (const key of ["schoolId", "revision", "createdBy", "updatedBy", "updatedVia"]) {
      expect(event[key]).toBeUndefined();
    }
    // The confirmation record (Issue #85) is staff information in
    // the same way: the stored record carries it — the fixture was
    // created confirmed, so the store stamped its creator — and
    // the public shape sheds it.
    const stored = await eventStore.get(A, "ev-public", "staff");
    expect(stored?.confirmedBy).toBe("person-a");
    expect(stored?.confirmedAt).not.toBeNull();
    for (const key of ["confirmedBy", "confirmedAt"]) {
      expect(event[key]).toBeUndefined();
    }
    const text = JSON.stringify(json);
    expect(text).not.toContain("staff-1");
    expect(text).not.toContain("外部講師");
    expect(text).not.toContain("person-a");
    expect(text).not.toContain("職員会議");
    expect(text).not.toContain("B校の行事");
  });

  it("a narrower audience sees less: the guardian event is hidden from public", async () => {
    const { json } = await api(`${BASE}/calendar/events?schoolId=${A}&audience=public&${NOVEMBER}`);
    expect((json.items ?? []).map((item) => item["id"])).toEqual([]);
  });

  it("days, holidays and grades are the named school's alone, in the public shape", async () => {
    const days = await api(`${BASE}/calendar/days?schoolId=${A}&audience=guardian&${NOVEMBER}`);
    expect((days.json.items ?? []).map((item) => item["id"])).toEqual(["day-a"]);
    const day = (days.json.items ?? [])[0] as Json;
    expect(day["dayType"]).toBe("event_day");
    for (const key of ["schoolId", "revision", "updatedBy", "updatedVia"]) {
      expect(day[key]).toBeUndefined();
    }

    const holidays = await api(
      `${BASE}/calendar/holidays?slug=school-a&audience=student&${NOVEMBER}`,
    );
    expect((holidays.json.items ?? []).map((item) => item["id"])).toEqual(["hol-a"]);
    expect((holidays.json.items ?? [])[0]?.["name"]).toBe("A校の休日");

    const grades = await api(`${BASE}/masters/grades?schoolId=${A}&audience=guardian`);
    expect((grades.json.items ?? []).map((item) => item["id"])).toEqual(["grade-a1"]);
    const grade = (grades.json.items ?? [])[0] as Json;
    expect(grade["name"]).toBe("1年");
    for (const key of ["schoolId", "revision", "updatedBy", "updatedVia"]) {
      expect(grade[key]).toBeUndefined();
    }
    // The staff master is not served on this path at all.
    expect((await api(`${BASE}/masters/staff?schoolId=${A}&audience=guardian`)).status).toBe(404);
  });

  it("the route itself empties assignees, even if the store stops shaping them away", async () => {
    // Today the store's audience shaping is what empties an
    // event's assignees before the route sees them. The public
    // shape must not rest on that alone (Issue #82 review): this
    // store answers the way an unshaped one would — the
    // assignees back on the record — and the route must still
    // send none of them out.
    const assignees: CalendarEventRecord["assignees"] = [
      { kind: "staff", staffId: "staff-1", role: "担当" },
      { kind: "free_text", name: "外部講師", role: "引率" },
    ];
    const unshapedStore: EventStore = {
      ...eventStore,
      listRange: async (schoolId, range, audience) => {
        const shaped = await eventStore.listRange(schoolId, range, audience);
        return shaped.map((record) =>
          record.id === "ev-public" ? { ...record, assignees } : record,
        );
      },
    };
    const leakyApp = createApp({
      publicRead: {
        authStore: createAuthStore(db),
        dayStore: createDayStore(db),
        holidayStore: createHolidayStore(db),
        eventStore: unshapedStore,
        masterStore: createMasterStore(db),
        serviceToken: TOKEN,
      },
    });
    const leakyServer = await new Promise<Server>((resolve) => {
      const s = leakyApp.listen(0, () => resolve(s));
    });
    try {
      const address = leakyServer.address();
      const leakyBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const res = await fetch(
        `${leakyBase}${BASE}/calendar/events?schoolId=${A}&audience=guardian&${NOVEMBER}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      const items = json.items ?? [];
      expect(items.map((item) => item["id"])).toEqual(["ev-public"]);
      expect(items[0]?.["assignees"]).toEqual([]);
      const text = JSON.stringify(json);
      expect(text).not.toContain("staff-1");
      expect(text).not.toContain("外部講師");
    } finally {
      leakyServer.close();
    }
  });
});
