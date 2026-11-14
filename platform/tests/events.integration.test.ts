import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createChangeStore, type ChangeStore } from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { createEventStore } from "../src/db/events.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  classes,
  grades,
  memberships,
  persons,
  productRoles,
  schools,
  specialNeedsClasses,
  staffMembers,
} from "../src/db/schema.js";

// School calendar events tests (Issue #24): CRUD with impacts /
// targets / assignees, revision conflicts, the audience filter
// (DESIGN-AUTH-TENANCY 4.5), cross-school reference refusal and
// two-school isolation. Runs only when PLATFORM_DATABASE_URL is set
// (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SECRET = "events-test-secret";
const BASE = "/platform/api/v1/calendar/events";
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

const EVENT_FULL = {
  id: "ev-full",
  title: "音楽祭",
  kind: "event",
  kindLabel: "学校行事",
  datePrecision: "range",
  startsOn: "2026-11-10",
  endsOn: "2026-11-11",
  time: { kind: "periods", from: 1, to: 4 },
  locationId: "loc-gym",
  locationText: "体育館",
  description: "全校で実施する",
  certainty: "confirmed",
  visibility: "guardian",
  targets: [
    { axis: "grade", id: "grade-7" },
    { axis: "app", app: "schedule", axisKey: "club", id: "brass-band" },
  ],
  impacts: [
    {
      kind: "block_periods",
      periods: { from: 1, to: 4 },
      targets: [{ axis: "grade", id: "grade-7" }],
    },
    { kind: "room_use", roomId: "gym", time: { kind: "all_day" } },
  ],
  assignees: [
    { kind: "staff", staffId: "staff-1", role: "担当" },
    { kind: "free_text", name: "外部講師", role: "引率" },
  ],
};

function dayEvent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: "行事",
    kind: "event",
    kindLabel: null,
    datePrecision: "day",
    startsOn: "2026-11-10",
    endsOn: null,
    time: { kind: "all_day" },
    locationId: null,
    locationText: null,
    description: null,
    certainty: "tentative",
    visibility: "public",
    targets: [],
    impacts: [],
    assignees: [],
    ...overrides,
  };
}

describe.skipIf(!url)("calendar events", () => {
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

  interface EventJson {
    id?: string;
    revision?: number;
    title?: string;
    assignees?: unknown[];
    targets?: unknown[];
    impacts?: unknown[];
    items?: EventJson[];
    latest?: Record<string, unknown>;
    error?: string;
    [key: string]: unknown;
  }

  interface ApiResult {
    status: number;
    json: EventJson;
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
    const json = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as EventJson;
    return { status: res.status, json };
  }

  async function seedMaster(
    table: typeof staffMembers | typeof grades | typeof classes | typeof specialNeedsClasses,
    values: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(table).values({
      revision: 1,
      updatedBy: "person-editor",
      updatedVia: "platform",
      ...values,
    } as never);
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
    // Shared masters of both schools, written directly (the masters
    // API is covered by its own tests).
    await seedMaster(staffMembers, {
      schoolId: A,
      id: "staff-1",
      name: "山田太郎",
      shortName: "山田",
      sortOrder: 1,
      active: true,
      personId: null,
    });
    await seedMaster(staffMembers, {
      schoolId: A,
      id: "staff-2",
      name: "佐藤花",
      shortName: "佐藤",
      sortOrder: 2,
      active: true,
      personId: null,
    });
    await seedMaster(grades, {
      schoolId: A,
      id: "grade-7",
      name: "7年",
      sortOrder: 7,
      stage: null,
    });
    await seedMaster(classes, {
      schoolId: A,
      id: "class-7-1",
      gradeId: "grade-7",
      name: "1組",
      sortOrder: 1,
    });
    await seedMaster(specialNeedsClasses, {
      schoolId: A,
      id: "special-1",
      name: "あおぞら",
      sortOrder: 1,
    });
    await seedMaster(staffMembers, {
      schoolId: B,
      id: "staff-b1",
      name: "B校教員",
      shortName: "B",
      sortOrder: 1,
      active: true,
      personId: null,
    });
    await seedMaster(grades, {
      schoolId: B,
      id: "grade-b",
      name: "B学年",
      sortOrder: 1,
      stage: null,
    });

    changeStore = createChangeStore(db);
    config = loadAuthConfig({ JWT_SECRET: SECRET });
    const app = createApp({
      events: { config, authStore: createAuthStore(db), eventStore: createEventStore(db) },
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

  it("creates an event with impacts, targets and assignees, and reads it back whole", async () => {
    const created = await api("POST", BASE, { cookie: editorA(), body: EVENT_FULL });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "ev-full",
      schoolId: A,
      title: "音楽祭",
      kindLabel: "学校行事",
      revision: 1,
      createdBy: "person-editor",
      updatedBy: "person-editor",
      updatedVia: "platform",
    });
    expect(created.json.targets).toEqual(EVENT_FULL.targets);
    expect(created.json.impacts).toEqual(EVENT_FULL.impacts);
    expect(created.json.assignees).toEqual(EVENT_FULL.assignees);

    const fetched = await api("GET", `${BASE}/ev-full`, { cookie: viewerA() });
    expect(fetched.status).toBe(200);
    expect(fetched.json.assignees).toEqual(EVENT_FULL.assignees);

    const listed = await api("GET", `${BASE}?${NOVEMBER}`, { cookie: viewerA() });
    expect((listed.json.items ?? []).map((i) => i.id)).toContain("ev-full");
  });

  it("updates an event under the revision lock and replaces its children wholesale", async () => {
    const updated = await api("PUT", `${BASE}/ev-full`, {
      cookie: editorA(),
      body: {
        ...EVENT_FULL,
        title: "音楽祭（変更）",
        targets: [{ axis: "class", id: "class-7-1" }],
        impacts: [],
        assignees: [{ kind: "staff", staffId: "staff-2", role: null }],
        revision: 1,
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ title: "音楽祭（変更）", revision: 2 });
    expect(updated.json.targets).toEqual([{ axis: "class", id: "class-7-1" }]);
    expect(updated.json.impacts).toEqual([]);
    expect(updated.json.assignees).toEqual([{ kind: "staff", staffId: "staff-2", role: null }]);
  });

  it("refuses a stale revision with 409 and a privacy-filtered latest", async () => {
    const conflict = await api("PUT", `${BASE}/ev-full`, {
      cookie: editorA(),
      body: { ...EVENT_FULL, revision: 1 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.latest).toMatchObject({
      id: "ev-full",
      revision: 2,
      title: "音楽祭（変更）",
    });
    // The 409 body must not carry assignees, description or the other
    // private payload (standing carry-over: filter latest).
    expect(conflict.json.latest).not.toHaveProperty("assignees");
    expect(conflict.json.latest).not.toHaveProperty("description");
    expect(conflict.json.latest).not.toHaveProperty("locationText");
    expect(conflict.json.latest).not.toHaveProperty("targets");
    expect(conflict.json.latest).not.toHaveProperty("impacts");

    const staleDelete = await api("DELETE", `${BASE}/ev-full`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(staleDelete.status).toBe(409);
  });

  it("deletes an event with the current revision", async () => {
    const removed = await api("DELETE", `${BASE}/ev-full`, {
      cookie: editorA(),
      body: { revision: 2 },
    });
    expect(removed.status).toBe(204);
    expect((await api("GET", `${BASE}/ev-full`, { cookie: editorA() })).status).toBe(404);
    // Deleting (or updating) what is not there is a 404, not a 500
    // (standing carry-over for missing / cross-school rows).
    expect(
      (await api("DELETE", `${BASE}/ev-full`, { cookie: editorA(), body: { revision: 3 } })).status,
    ).toBe(404);
    expect(
      (
        await api("PUT", `${BASE}/ev-full`, {
          cookie: editorA(),
          body: { ...EVENT_FULL, revision: 3 },
        })
      ).status,
    ).toBe(404);
  });

  it("records creates, updates and deletes in the outbox", async () => {
    const created = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-outbox"),
    });
    expect(created.status).toBe(201);
    await api("PUT", `${BASE}/ev-outbox`, {
      cookie: editorA(),
      body: { ...dayEvent("ev-outbox"), title: "記録用2", revision: 1 },
    });
    await api("DELETE", `${BASE}/ev-outbox`, { cookie: editorA(), body: { revision: 2 } });
    const changes = await changeStore.listChanges(A, 0, 500);
    const mine = changes.filter((c) => c.kind === "event" && c.entityId === "ev-outbox");
    expect(mine.map((c) => [c.op, c.revision])).toEqual([
      ["upsert", 1],
      ["upsert", 2],
      ["delete", 3],
    ]);
    expect(mine[0]?.actor).toEqual({ userId: "person-editor", via: "platform" });
  });

  it("hides staff_only events and all assignee names from a guardian audience", async () => {
    await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-open", {
        title: "公開行事",
        visibility: "guardian",
        targets: [
          { axis: "grade", id: "grade-7" },
          { axis: "staff", id: "staff-1" },
        ],
        assignees: [
          { kind: "staff", staffId: "staff-1", role: "担当" },
          { kind: "free_text", name: "外部講師", role: null },
        ],
      }),
    });
    await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-staff-only", {
        title: "職員会議",
        visibility: "staff_only",
        assignees: [{ kind: "staff", staffId: "staff-2", role: "担当" }],
      }),
    });

    const forGuardian = await api("GET", `${BASE}?${NOVEMBER}&audience=guardian`, {
      cookie: viewerA(),
    });
    const guardianIds = (forGuardian.json.items ?? []).map((i) => i.id);
    expect(guardianIds).toContain("ev-open");
    expect(guardianIds).not.toContain("ev-staff-only");
    const open = (forGuardian.json.items ?? []).find((i) => i.id === "ev-open");
    expect(open?.assignees).toEqual([]);
    // Staff ids do not reach a non-staff audience: no staff-axis
    // targets, and no creator / updater person ids.
    expect(open?.targets).toEqual([{ axis: "grade", id: "grade-7" }]);
    expect(open).not.toHaveProperty("createdBy");
    expect(open).not.toHaveProperty("updatedBy");

    expect(
      (await api("GET", `${BASE}/ev-staff-only?audience=guardian`, { cookie: viewerA() })).status,
    ).toBe(404);
    const openForGuardian = await api("GET", `${BASE}/ev-open?audience=guardian`, {
      cookie: viewerA(),
    });
    expect(openForGuardian.status).toBe(200);
    expect(openForGuardian.json.assignees).toEqual([]);
    expect(openForGuardian.json.targets).toEqual([{ axis: "grade", id: "grade-7" }]);
    expect(openForGuardian.json).not.toHaveProperty("createdBy");
    expect(openForGuardian.json).not.toHaveProperty("updatedBy");

    // The default (staff) audience still sees everything, names included.
    const forStaff = await api("GET", `${BASE}?${NOVEMBER}`, { cookie: viewerA() });
    const staffOnly = (forStaff.json.items ?? []).find((i) => i.id === "ev-staff-only");
    expect(staffOnly?.assignees).toEqual([{ kind: "staff", staffId: "staff-2", role: "担当" }]);
    const openForStaff = (forStaff.json.items ?? []).find((i) => i.id === "ev-open");
    expect(openForStaff?.targets).toEqual([
      { axis: "grade", id: "grade-7" },
      { axis: "staff", id: "staff-1" },
    ]);
    expect(openForStaff?.createdBy).toBe("person-editor");
    expect(openForStaff?.updatedBy).toBe("person-editor");

    // A student audience does not see a guardian-visibility event,
    // and an unknown audience is a 400.
    expect(
      (await api("GET", `${BASE}/ev-open?audience=student`, { cookie: viewerA() })).status,
    ).toBe(404);
    expect(
      (await api("GET", `${BASE}?${NOVEMBER}&audience=aliens`, { cookie: viewerA() })).status,
    ).toBe(400);
    expect((await api("GET", BASE, { cookie: viewerA() })).status).toBe(400);
  });

  it("returns month events in their month and undecided events in a school-year range", async () => {
    await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-month", {
        title: "月のみ確定",
        datePrecision: "month",
        startsOn: "2026-11-15",
      }),
    });
    // An undecided event names its school year by April 1 of that year.
    const undecided2026 = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-undecided", {
        title: "時期未定",
        datePrecision: "undecided",
        startsOn: "2026-04-01",
      }),
    });
    expect(undecided2026.status).toBe(201);
    const undecided2027 = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-undecided-2027", {
        title: "時期未定（翌年度）",
        datePrecision: "undecided",
        startsOn: "2027-04-01",
      }),
    });
    expect(undecided2027.status).toBe(201);
    // An undecided event without a school year, or with a startsOn that
    // is not April 1, is refused.
    expect(
      (
        await api("POST", BASE, {
          cookie: editorA(),
          body: dayEvent("ev-undecided-bad", {
            datePrecision: "undecided",
            startsOn: null,
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", BASE, {
          cookie: editorA(),
          body: dayEvent("ev-undecided-bad-2", {
            datePrecision: "undecided",
            startsOn: "2026-11-01",
          }),
        })
      ).status,
    ).toBe(400);

    const lateNovember = await api("GET", `${BASE}?from=2026-11-20&to=2026-11-25`, {
      cookie: viewerA(),
    });
    expect((lateNovember.json.items ?? []).map((i) => i.id)).toContain("ev-month");
    const december = await api("GET", `${BASE}?from=2026-12-01&to=2026-12-31`, {
      cookie: viewerA(),
    });
    expect((december.json.items ?? []).map((i) => i.id)).not.toContain("ev-month");

    expect(
      (await api("GET", `${BASE}?${NOVEMBER}`, { cookie: viewerA() })).json.items?.map((i) => i.id),
    ).not.toContain("ev-undecided");
    // Each school-year query returns only its own year's undecided event.
    const year = await api("GET", `${BASE}?from=2026-04-01&to=2027-03-31`, {
      cookie: viewerA(),
    });
    const yearIds = (year.json.items ?? []).map((i) => i.id);
    expect(yearIds).toContain("ev-undecided");
    expect(yearIds).not.toContain("ev-undecided-2027");
    const nextYear = await api("GET", `${BASE}?from=2027-04-01&to=2028-03-31`, {
      cookie: viewerA(),
    });
    const nextYearIds = (nextYear.json.items ?? []).map((i) => i.id);
    expect(nextYearIds).toContain("ev-undecided-2027");
    expect(nextYearIds).not.toContain("ev-undecided");
  });

  it("refuses targets and assignees that belong to another school, or do not exist", async () => {
    const crossTarget = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-cross-1", { targets: [{ axis: "grade", id: "grade-b" }] }),
    });
    expect(crossTarget.status).toBe(400);
    const missingTarget = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-cross-2", { targets: [{ axis: "grade", id: "grade-99" }] }),
    });
    expect(missingTarget.status).toBe(400);
    const crossAssignee = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-cross-3", {
        assignees: [{ kind: "staff", staffId: "staff-b1", role: null }],
      }),
    });
    expect(crossAssignee.status).toBe(400);
    const crossImpact = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-cross-4", {
        impacts: [
          {
            kind: "block_periods",
            periods: { from: 1, to: 2 },
            targets: [{ axis: "staff", id: "staff-b1" }],
          },
        ],
      }),
    });
    expect(crossImpact.status).toBe(400);

    // The same school's masters pass, and app / room references are
    // stored without an existence check (they have no platform master).
    const ok = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-refs-ok", {
        targets: [
          { axis: "class", id: "class-7-1" },
          { axis: "special_needs_class", id: "special-1" },
          { axis: "staff", id: "staff-1" },
          { axis: "room", id: "room-anything" },
          { axis: "app", app: "schedule", axisKey: "bus", id: "route-3" },
        ],
      }),
    });
    expect(ok.status).toBe(201);
  });

  it("refuses writes from a Viewer, lets the other product's Editor write, and keeps schools apart", async () => {
    expect(
      (await api("POST", BASE, { cookie: viewerA(), body: dayEvent("ev-viewer") })).status,
    ).toBe(403);
    expect((await api("GET", `${BASE}?${NOVEMBER}`, {})).status).toBe(401);
    const outsider = sessionCookie("person-outsider", A);
    expect((await api("GET", `${BASE}?${NOVEMBER}`, { cookie: outsider })).status).toBe(403);

    const byTimetable = await api("POST", BASE, {
      cookie: timetableEditorA(),
      body: dayEvent("ev-tt"),
    });
    expect(byTimetable.status).toBe(201);
    expect(byTimetable.json.createdBy).toBe("person-tt-editor");

    // School B sees none of A's events, cannot read, update or delete
    // them, and may reuse the same event id for its own event.
    const listedForB = await api("GET", `${BASE}?${NOVEMBER}`, { cookie: memberB() });
    expect((listedForB.json.items ?? []).map((i) => i.id)).toEqual([]);
    expect((await api("GET", `${BASE}/ev-open`, { cookie: memberB() })).status).toBe(404);
    expect(
      (
        await api("PUT", `${BASE}/ev-open`, {
          cookie: memberB(),
          body: { ...dayEvent("ev-open"), revision: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api("DELETE", `${BASE}/ev-open`, { cookie: memberB(), body: { revision: 1 } })).status,
    ).toBe(404);
    const ownB = await api("POST", BASE, { cookie: memberB(), body: dayEvent("ev-open") });
    expect(ownB.status).toBe(201);
    const forA = await api("GET", `${BASE}/ev-open`, { cookie: editorA() });
    expect(forA.json.title).toBe("公開行事");
  });

  it("refuses a second event with the same id in the same school, and invalid input", async () => {
    expect((await api("POST", BASE, { cookie: editorA(), body: dayEvent("ev-open") })).status).toBe(
      409,
    );
    expect(
      (
        await api("POST", BASE, {
          cookie: editorA(),
          body: { ...dayEvent("ev-bad"), schoolId: B },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", BASE, {
          cookie: editorA(),
          body: dayEvent("ev-bad-2", { datePrecision: "range", endsOn: null }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", BASE, {
          cookie: editorA(),
          body: dayEvent("ev-bad-3", { kind: "festival" }),
        })
      ).status,
    ).toBe(400);
  });

  it("answers the write-check with the write guard's own verdict, and writes nothing", async () => {
    const created = await api("POST", BASE, { cookie: editorA(), body: dayEvent("ev-check") });
    expect(created.status).toBe(201);
    // A writer may write it — from either product （連携5).
    expect((await api("GET", `${BASE}/ev-check/write-check`, { cookie: editorA() })).status).toBe(
      200,
    );
    expect(
      (await api("GET", `${BASE}/ev-check/write-check`, { cookie: timetableEditorA() })).status,
    ).toBe(200);
    // A Viewer may not.
    expect((await api("GET", `${BASE}/ev-check/write-check`, { cookie: viewerA() })).status).toBe(
      403,
    );
    // A missing event is a 404 even for a writer, another school's
    // writer gets the 404 too, and no session is a 401.
    expect((await api("GET", `${BASE}/ev-missing/write-check`, { cookie: editorA() })).status).toBe(
      404,
    );
    expect((await api("GET", `${BASE}/ev-check/write-check`, { cookie: memberB() })).status).toBe(
      404,
    );
    expect((await api("GET", `${BASE}/ev-check/write-check`)).status).toBe(401);
    // The check wrote nothing: the record is still at revision 1.
    const read = await api("GET", `${BASE}/ev-check`, { cookie: editorA() });
    expect(read.json.revision).toBe(1);
  });

  it("accepts an update sent in the read shape, as a move sends it", async () => {
    await api("POST", BASE, { cookie: editorA(), body: dayEvent("ev-move-shape") });
    const read = await api("GET", `${BASE}/ev-move-shape`, { cookie: editorA() });
    expect(read.status).toBe(200);
    // The read body carries the stamps (createdBy, createdAt, ...);
    // the schedule relay's move spreads it whole and replaces only
    // the dates. The input schema ignores the read-only fields.
    const moved = await api("PUT", `${BASE}/ev-move-shape`, {
      cookie: editorA(),
      body: { ...read.json, startsOn: "2026-11-12", endsOn: "2026-11-12" },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.startsOn).toBe("2026-11-12");
    expect(moved.json.revision).toBe(2);
  });
});
