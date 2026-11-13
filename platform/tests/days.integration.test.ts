import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createChangeStore, type ChangeStore } from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { createDayStore, createHolidayStore } from "../src/db/days.js";
import { runMigrations } from "../src/db/migrate.js";
import { dayPatterns, memberships, persons, productRoles, schools } from "../src/db/schema.js";

// School calendar days and holidays tests (Issue #23): CRUD with
// the revision lock, two-school isolation, refusal of another
// school's day pattern, and the recorded-days-only range read (a
// date with no record is the default day and is NOT returned).
// Runs only when PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SECRET = "days-test-secret";
const DAYS = "/platform/api/v1/calendar/days";
const HOLIDAYS = "/platform/api/v1/calendar/holidays";
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

function dayInput(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    date: "2026-11-09",
    dayType: "class_day",
    dayTypeLabel: null,
    dayScheduleId: null,
    weekdaySwap: null,
    note: null,
    ...overrides,
  };
}

function holidayInput(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    date: "2026-11-03",
    name: "文化の日",
    kind: "national_holiday",
    ...overrides,
  };
}

describe.skipIf(!url)("calendar days and holidays", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let changeStore: ChangeStore;
  let config: AuthConfig;
  let server: Server;
  let baseUrl: string;

  function sessionCookie(personId: string, schoolId: string): string {
    const token = signSessionToken(config, {
      personId,
      schoolId,
      email: `${personId}@example.jp`,
    });
    return `platform_session=${encodeURIComponent(token)}`;
  }

  const editorA = () => sessionCookie("person-editor", A);
  const timetableEditorA = () => sessionCookie("person-tt-editor", A);
  const viewerA = () => sessionCookie("person-viewer", A);
  const memberB = () => sessionCookie("person-b", B);

  interface EntryJson {
    id?: string;
    revision?: number;
    items?: EntryJson[];
    latest?: Record<string, unknown>;
    error?: string;
    [key: string]: unknown;
  }

  interface ApiResult {
    status: number;
    json: EntryJson;
  }

  async function api(
    method: string,
    path: string,
    options: { cookie?: string; body?: unknown } = {},
  ): Promise<ApiResult> {
    const init: RequestInit = {
      method,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await fetch(`${baseUrl}${path}`, init);
    const json = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as EntryJson;
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
    await runMigrations(db);

    await db.insert(schools).values([
      { schoolId: A, slug: "school-a", name: "A校" },
      { schoolId: B, slug: "school-b", name: "B校" },
    ]);
    await db.insert(persons).values([
      { id: "person-editor", email: "editor@example.jp", displayName: "編集者" },
      { id: "person-tt-editor", email: "tt@example.jp", displayName: "時間割編集者" },
      { id: "person-viewer", email: "viewer@example.jp", displayName: "閲覧者" },
      { id: "person-b", email: "b@example.jp", displayName: "B校教員" },
      { id: "person-outsider", email: "outsider@example.jp", displayName: "部外者" },
    ]);
    await db.insert(memberships).values([
      { id: "membership-editor-a", schoolId: A, personId: "person-editor", status: "approved" },
      { id: "membership-tt-a", schoolId: A, personId: "person-tt-editor", status: "approved" },
      { id: "membership-viewer-a", schoolId: A, personId: "person-viewer", status: "approved" },
      { id: "membership-b", schoolId: B, personId: "person-b", status: "approved" },
    ]);
    await db.insert(productRoles).values([
      {
        id: "role-editor-schedule",
        schoolId: A,
        membershipId: "membership-editor-a",
        product: "schedule",
        role: "Editor",
      },
      {
        id: "role-tt-timetable",
        schoolId: A,
        membershipId: "membership-tt-a",
        product: "timetable",
        role: "Editor",
      },
      {
        id: "role-viewer-schedule",
        schoolId: A,
        membershipId: "membership-viewer-a",
        product: "schedule",
        role: "Viewer",
      },
      {
        id: "role-b-schedule",
        schoolId: B,
        membershipId: "membership-b",
        product: "schedule",
        role: "Editor",
      },
    ]);
    // Day patterns of both schools, written directly (the masters
    // API is covered by its own tests).
    await db.insert(dayPatterns).values([
      {
        schoolId: A,
        id: "pattern-a",
        kind: "normal",
        code: "A",
        name: "A日課",
        revision: 1,
        updatedBy: "person-editor",
        updatedVia: "platform",
      },
      {
        schoolId: A,
        id: "pattern-short",
        kind: "shortened",
        code: "短",
        name: "短縮日課",
        revision: 1,
        updatedBy: "person-editor",
        updatedVia: "platform",
      },
      {
        schoolId: B,
        id: "pattern-b",
        kind: "normal",
        code: "B",
        name: "B日課",
        revision: 1,
        updatedBy: "person-b",
        updatedVia: "platform",
      },
    ]);

    changeStore = createChangeStore(db);
    config = loadAuthConfig({ JWT_SECRET: SECRET });
    const app = createApp({
      calendar: {
        config,
        authStore: createAuthStore(db),
        dayStore: createDayStore(db),
        holidayStore: createHolidayStore(db),
      },
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await queryClient.end();
  });

  it("creates a day with a pattern, a label, a swap and a note, and reads it back", async () => {
    const created = await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-1109", {
        dayTypeLabel: "授業日",
        dayScheduleId: "pattern-short",
        weekdaySwap: "wed",
        note: "水曜時間割で実施",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "day-1109",
      schoolId: A,
      date: "2026-11-09",
      dayType: "class_day",
      dayTypeLabel: "授業日",
      dayScheduleId: "pattern-short",
      weekdaySwap: "wed",
      note: "水曜時間割で実施",
      revision: 1,
      updatedBy: "person-editor",
      updatedVia: "platform",
    });

    const fetched = await api("GET", `${DAYS}/day-1109`, { cookie: viewerA() });
    expect(fetched.status).toBe(200);
    expect(fetched.json.note).toBe("水曜時間割で実施");
  });

  it("returns only recorded days in a range read, sorted by date", async () => {
    await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-1102", {
        date: "2026-11-02",
        dayType: "event_day",
        dayTypeLabel: "文化祭",
      }),
    });
    await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-1201", { date: "2026-12-01" }),
    });
    const listed = await api("GET", `${DAYS}?${NOVEMBER}`, { cookie: viewerA() });
    expect(listed.status).toBe(200);
    // 2026-11-10 (Tue) has no record: it is a default class day and
    // must NOT appear — the API returns recorded days only.
    expect((listed.json.items ?? []).map((i) => i.date)).toEqual(["2026-11-02", "2026-11-09"]);
    expect((await api("GET", `${DAYS}`, { cookie: viewerA() })).status).toBe(400);
    expect(
      (await api("GET", `${DAYS}?from=2026-11-30&to=2026-11-01`, { cookie: viewerA() })).status,
    ).toBe(400);
  });

  it("updates a day under the revision lock and refuses stale revisions with 409", async () => {
    const updated = await api("PUT", `${DAYS}/day-1109`, {
      cookie: editorA(),
      body: dayInput("day-1109", {
        dayType: "attendance_day",
        dayTypeLabel: "登校日",
        dayScheduleId: "pattern-a",
        revision: 1,
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ dayType: "attendance_day", revision: 2 });

    const conflict = await api("PUT", `${DAYS}/day-1109`, {
      cookie: editorA(),
      body: dayInput("day-1109", { revision: 1 }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.latest).toMatchObject({
      id: "day-1109",
      revision: 2,
      dayType: "attendance_day",
    });

    const staleDelete = await api("DELETE", `${DAYS}/day-1109`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(staleDelete.status).toBe(409);
  });

  it("deletes a day with the current revision, then answers 404", async () => {
    const removed = await api("DELETE", `${DAYS}/day-1109`, {
      cookie: editorA(),
      body: { revision: 2 },
    });
    expect(removed.status).toBe(204);
    expect((await api("GET", `${DAYS}/day-1109`, { cookie: editorA() })).status).toBe(404);
    expect(
      (await api("DELETE", `${DAYS}/day-1109`, { cookie: editorA(), body: { revision: 3 } }))
        .status,
    ).toBe(404);
    expect(
      (
        await api("PUT", `${DAYS}/day-1109`, {
          cookie: editorA(),
          body: dayInput("day-1109", { revision: 3 }),
        })
      ).status,
    ).toBe(404);
  });

  it("refuses a second day for the same date, and the same id twice", async () => {
    const dupDate = await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-other", { date: "2026-11-02" }),
    });
    expect(dupDate.status).toBe(409);
    const dupId = await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-1102", { date: "2026-11-20" }),
    });
    expect(dupId.status).toBe(409);
  });

  it("refuses another school's day pattern, and one that does not exist", async () => {
    const cross = await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-cross", { date: "2026-11-16", dayScheduleId: "pattern-b" }),
    });
    expect(cross.status).toBe(400);
    const missing = await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-missing", { date: "2026-11-16", dayScheduleId: "pattern-99" }),
    });
    expect(missing.status).toBe(400);
    const crossUpdate = await api("PUT", `${DAYS}/day-1102`, {
      cookie: editorA(),
      body: dayInput("day-1102", {
        date: "2026-11-02",
        dayScheduleId: "pattern-b",
        revision: 1,
      }),
    });
    expect(crossUpdate.status).toBe(400);
    // The school's own pattern and a null pattern (the default) pass.
    const own = await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-1116", { date: "2026-11-16", dayScheduleId: "pattern-a" }),
    });
    expect(own.status).toBe(201);
  });

  it("refuses writes from a Viewer, lets the other product's Editor write", async () => {
    expect(
      (await api("POST", DAYS, { cookie: viewerA(), body: dayInput("day-viewer") })).status,
    ).toBe(403);
    expect((await api("GET", `${DAYS}?${NOVEMBER}`, {})).status).toBe(401);
    const outsider = sessionCookie("person-outsider", A);
    expect((await api("GET", `${DAYS}?${NOVEMBER}`, { cookie: outsider })).status).toBe(403);

    const byTimetable = await api("POST", DAYS, {
      cookie: timetableEditorA(),
      body: dayInput("day-tt", { date: "2026-11-24" }),
    });
    expect(byTimetable.status).toBe(201);
    expect(byTimetable.json.updatedBy).toBe("person-tt-editor");
  });

  it("keeps the two schools' days apart", async () => {
    const listedForB = await api("GET", `${DAYS}?${NOVEMBER}`, { cookie: memberB() });
    expect((listedForB.json.items ?? []).map((i) => i.id)).toEqual([]);
    expect((await api("GET", `${DAYS}/day-1102`, { cookie: memberB() })).status).toBe(404);
    expect(
      (
        await api("PUT", `${DAYS}/day-1102`, {
          cookie: memberB(),
          body: dayInput("day-1102", { revision: 1 }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await api("DELETE", `${DAYS}/day-1102`, { cookie: memberB(), body: { revision: 1 } }))
        .status,
    ).toBe(404);
    // The same id and the same date are free in school B.
    const ownB = await api("POST", DAYS, {
      cookie: memberB(),
      body: dayInput("day-1102", { date: "2026-11-02", dayScheduleId: "pattern-b" }),
    });
    expect(ownB.status).toBe(201);
    const forA = await api("GET", `${DAYS}/day-1102`, { cookie: editorA() });
    expect(forA.json.dayType).toBe("event_day");
  });

  it("records day creates, updates and deletes in the outbox", async () => {
    await api("POST", DAYS, {
      cookie: editorA(),
      body: dayInput("day-outbox", { date: "2026-11-25" }),
    });
    await api("PUT", `${DAYS}/day-outbox`, {
      cookie: editorA(),
      body: dayInput("day-outbox", { date: "2026-11-25", note: "記録用", revision: 1 }),
    });
    await api("DELETE", `${DAYS}/day-outbox`, { cookie: editorA(), body: { revision: 2 } });
    const changes = await changeStore.listChanges(A, 0, 500);
    const mine = changes.filter((c) => c.kind === "day" && c.entityId === "day-outbox");
    expect(mine.map((c) => [c.op, c.revision])).toEqual([
      ["upsert", 1],
      ["upsert", 2],
      ["delete", 3],
    ]);
    expect(mine[0]?.actor).toEqual({ userId: "person-editor", via: "platform" });
  });

  it("refuses invalid day input", async () => {
    expect(
      (
        await api("POST", DAYS, {
          cookie: editorA(),
          body: dayInput("day-bad-1", { dayType: "festival" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", DAYS, {
          cookie: editorA(),
          body: dayInput("day-bad-2", { date: "2026-02-30" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", DAYS, {
          cookie: editorA(),
          body: dayInput("day-bad-3", { weekdaySwap: "funday" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", DAYS, {
          cookie: editorA(),
          body: { ...dayInput("day-bad-4"), schoolId: B },
        })
      ).status,
    ).toBe(400);
  });

  it("creates holidays, allows two kinds on one date, and reads them back by range", async () => {
    const created = await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-1103"),
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "hol-1103",
      schoolId: A,
      date: "2026-11-03",
      name: "文化の日",
      kind: "national_holiday",
      revision: 1,
    });
    const second = await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-1103-closed", { name: "学校休業日", kind: "school_closed_day" }),
    });
    expect(second.status).toBe(201);
    await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-1123", { date: "2026-11-23", name: "勤労感謝の日" }),
    });
    await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-1205", {
        date: "2026-12-05",
        name: "閉庁日",
        kind: "office_closed_day",
      }),
    });

    const listed = await api("GET", `${HOLIDAYS}?${NOVEMBER}`, { cookie: viewerA() });
    expect((listed.json.items ?? []).map((i) => i.id)).toEqual([
      "hol-1103",
      "hol-1103-closed",
      "hol-1123",
    ]);
    const fetched = await api("GET", `${HOLIDAYS}/hol-1103`, { cookie: viewerA() });
    expect(fetched.status).toBe(200);
    expect(fetched.json.name).toBe("文化の日");
  });

  it("updates a holiday under the revision lock, refuses stale revisions, and deletes it", async () => {
    const updated = await api("PUT", `${HOLIDAYS}/hol-1103`, {
      cookie: editorA(),
      body: holidayInput("hol-1103", {
        name: "文化の日（振替）",
        kind: "substitute_holiday",
        revision: 1,
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ kind: "substitute_holiday", revision: 2 });

    const conflict = await api("PUT", `${HOLIDAYS}/hol-1103`, {
      cookie: editorA(),
      body: holidayInput("hol-1103", { revision: 1 }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.latest).toMatchObject({
      id: "hol-1103",
      revision: 2,
      kind: "substitute_holiday",
    });

    const removed = await api("DELETE", `${HOLIDAYS}/hol-1103`, {
      cookie: editorA(),
      body: { revision: 2 },
    });
    expect(removed.status).toBe(204);
    expect((await api("GET", `${HOLIDAYS}/hol-1103`, { cookie: editorA() })).status).toBe(404);
    expect(
      (await api("DELETE", `${HOLIDAYS}/hol-1103`, { cookie: editorA(), body: { revision: 3 } }))
        .status,
    ).toBe(404);
  });

  it("keeps the two schools' holidays apart and guards holiday writes", async () => {
    expect(
      (await api("POST", HOLIDAYS, { cookie: viewerA(), body: holidayInput("hol-viewer") })).status,
    ).toBe(403);
    const listedForB = await api("GET", `${HOLIDAYS}?${NOVEMBER}`, { cookie: memberB() });
    expect((listedForB.json.items ?? []).map((i) => i.id)).toEqual([]);
    expect((await api("GET", `${HOLIDAYS}/hol-1123`, { cookie: memberB() })).status).toBe(404);
    expect(
      (await api("DELETE", `${HOLIDAYS}/hol-1123`, { cookie: memberB(), body: { revision: 1 } }))
        .status,
    ).toBe(404);
    const ownB = await api("POST", HOLIDAYS, { cookie: memberB(), body: holidayInput("hol-1123") });
    expect(ownB.status).toBe(201);
  });

  it("records holiday writes in the outbox and refuses invalid holiday input", async () => {
    const changes = await changeStore.listChanges(A, 0, 500);
    const mine = changes.filter((c) => c.kind === "holiday" && c.entityId === "hol-1123");
    expect(mine.map((c) => [c.op, c.revision])).toEqual([["upsert", 1]]);
    expect(
      (
        await api("POST", HOLIDAYS, {
          cookie: editorA(),
          body: holidayInput("hol-bad", { kind: "festival" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await api("POST", HOLIDAYS, { cookie: editorA(), body: holidayInput("hol-1123") })).status,
    ).toBe(409);
  });

  it("refuses a second holiday of the same kind on one date, on create and on update", async () => {
    const first = await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-dup-1", { date: "2026-11-15" }),
    });
    expect(first.status).toBe(201);

    // The same date with the same kind is a duplicate, even under a
    // different id and name (e.g. importing the yearly list twice).
    const dupKind = await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-dup-2", { date: "2026-11-15", name: "文化の日（再取込）" }),
    });
    expect(dupKind.status).toBe(409);
    expect((await api("GET", `${HOLIDAYS}/hol-dup-2`, { cookie: editorA() })).status).toBe(404);

    // A different kind on the same date is still allowed.
    const otherKind = await api("POST", HOLIDAYS, {
      cookie: editorA(),
      body: holidayInput("hol-dup-3", {
        date: "2026-11-15",
        name: "学校休業日",
        kind: "school_closed_day",
      }),
    });
    expect(otherKind.status).toBe(201);

    // Updating that row into the already-taken (date, kind) pair is
    // refused too, and the row is left unchanged.
    const dupUpdate = await api("PUT", `${HOLIDAYS}/hol-dup-3`, {
      cookie: editorA(),
      body: holidayInput("hol-dup-3", {
        date: "2026-11-15",
        name: "文化の日",
        kind: "national_holiday",
        revision: 1,
      }),
    });
    expect(dupUpdate.status).toBe(409);
    const after = await api("GET", `${HOLIDAYS}/hol-dup-3`, { cookie: editorA() });
    expect(after.json).toMatchObject({ kind: "school_closed_day", revision: 1 });
  });
});
