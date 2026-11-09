import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createChangeStore, type ChangeStore } from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { createMasterStore, type MasterStore } from "../src/db/masters.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships, persons, productRoles, schools, staffMembers } from "../src/db/schema.js";

// Shared masters tests (Issue #22): CRUD and permissions over HTTP,
// two-school isolation, the membership teacher link, and the outbox
// record. Runs only when PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SECRET = "masters-test-secret";

const STAFF_1 = {
  id: "staff-1",
  name: "山田太郎",
  shortName: "山田",
  sortOrder: 1,
  active: true,
  personId: null,
};

const PATTERN_1 = {
  id: "pattern-1",
  name: "通常日課",
  kind: "normal",
  periods: [
    { period: 0, label: "朝", startsAt: "08:00", endsAt: "08:40" },
    { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
    { period: 99, label: "放課後", startsAt: "15:40", endsAt: "16:30" },
  ],
};

describe.skipIf(!url)("shared masters", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let masterStore: MasterStore;
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

  interface MasterJson {
    id?: string;
    revision?: number;
    updatedBy?: string;
    gradeId?: string;
    items?: MasterJson[];
    latest?: MasterJson;
    periods?: Array<{ period: number; label: string; startsAt: string; endsAt: string }>;
    error?: string;
    [key: string]: unknown;
  }

  interface ApiResult {
    status: number;
    json: MasterJson;
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
    const json = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as MasterJson;
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
        id: "role-viewer-timetable",
        schoolId: A,
        membershipId: "membership-viewer-a",
        product: "timetable",
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
    // School B has its own staff row, used by the isolation tests.
    await db.insert(staffMembers).values({
      schoolId: B,
      id: "staff-b1",
      name: "B校教員",
      shortName: "B",
      sortOrder: 1,
      active: true,
      personId: null,
      revision: 1,
      updatedBy: "person-b",
      updatedVia: "platform",
    });

    masterStore = createMasterStore(db);
    changeStore = createChangeStore(db);
    config = loadAuthConfig({ JWT_SECRET: SECRET } as NodeJS.ProcessEnv);
    const app = createApp({
      masters: { config, authStore: createAuthStore(db), masterStore },
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

  it("creates, reads back, updates and deletes a staff member", async () => {
    const created = await api("POST", "/platform/api/v1/masters/staff", {
      cookie: editorA(),
      body: STAFF_1,
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      ...STAFF_1,
      schoolId: A,
      revision: 1,
      updatedBy: "person-editor",
      updatedVia: "platform",
    });

    const listed = await api("GET", "/platform/api/v1/masters/staff", { cookie: viewerA() });
    expect(listed.status).toBe(200);
    expect((listed.json.items ?? []).map((i) => i.id)).toEqual(["staff-1"]);

    const updated = await api("PUT", "/platform/api/v1/masters/staff/staff-1", {
      cookie: editorA(),
      body: { ...STAFF_1, shortName: "山田改", revision: 1 },
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ shortName: "山田改", revision: 2 });

    const removed = await api("DELETE", "/platform/api/v1/masters/staff/staff-1", {
      cookie: editorA(),
      body: { revision: 2 },
    });
    expect(removed.status).toBe(204);
    const after = await api("GET", "/platform/api/v1/masters/staff/staff-1", {
      cookie: editorA(),
    });
    expect(after.status).toBe(404);
  });

  it("round-trips grades, classes and special-needs classes", async () => {
    const grade = await api("POST", "/platform/api/v1/masters/grades", {
      cookie: editorA(),
      body: { id: "grade-7", name: "7年", sortOrder: 7, stage: "後期課程" },
    });
    expect(grade.status).toBe(201);
    const klass = await api("POST", "/platform/api/v1/masters/classes", {
      cookie: editorA(),
      body: { id: "class-7-1", gradeId: "grade-7", name: "1組", sortOrder: 1 },
    });
    expect(klass.status).toBe(201);
    const special = await api("POST", "/platform/api/v1/masters/special-needs-classes", {
      cookie: editorA(),
      body: { id: "special-1", name: "あおぞら", sortOrder: 1 },
    });
    expect(special.status).toBe(201);
    const listed = await api("GET", "/platform/api/v1/masters/classes", { cookie: viewerA() });
    expect(listed.json.items).toHaveLength(1);
    expect(listed.json.items?.[0]).toMatchObject({ id: "class-7-1", gradeId: "grade-7" });
  });

  it("round-trips a day pattern with its periods, bands included", async () => {
    const created = await api("POST", "/platform/api/v1/masters/day-patterns", {
      cookie: editorA(),
      body: PATTERN_1,
    });
    expect(created.status).toBe(201);
    expect((created.json.periods ?? []).map((p) => p.period)).toEqual([0, 1, 99]);

    const updated = await api("PUT", "/platform/api/v1/masters/day-patterns/pattern-1", {
      cookie: editorA(),
      body: {
        ...PATTERN_1,
        revision: 1,
        periods: [{ period: 1, label: "1限", startsAt: "08:55", endsAt: "09:45" }],
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ revision: 2 });
    expect(updated.json.periods).toEqual([
      { period: 1, label: "1限", startsAt: "08:55", endsAt: "09:45" },
    ]);
  });

  it("refuses writes from a Viewer-only member, and from non-members and anonymous calls", async () => {
    const body = {
      id: "staff-x",
      name: "誰か",
      shortName: "誰",
      sortOrder: 9,
      active: true,
      personId: null,
    };
    expect(
      (await api("POST", "/platform/api/v1/masters/staff", { cookie: viewerA(), body })).status,
    ).toBe(403);
    expect(
      (
        await api("PUT", "/platform/api/v1/masters/staff/staff-b1", {
          cookie: viewerA(),
          body: { ...body, revision: 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("DELETE", "/platform/api/v1/masters/staff/staff-b1", {
          cookie: viewerA(),
          body: { revision: 1 },
        })
      ).status,
    ).toBe(403);
    const outsider = sessionCookie("person-outsider", A);
    expect((await api("GET", "/platform/api/v1/masters/staff", { cookie: outsider })).status).toBe(
      403,
    );
    expect((await api("GET", "/platform/api/v1/masters/staff", {})).status).toBe(401);
  });

  it("lets an Editor of the other product write （連携5)", async () => {
    const created = await api("POST", "/platform/api/v1/masters/staff", {
      cookie: timetableEditorA(),
      body: {
        id: "staff-tt",
        name: "時間割先生",
        shortName: "時間",
        sortOrder: 5,
        active: true,
        personId: null,
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.updatedBy).toBe("person-tt-editor");
  });

  it("never leaks another school's masters across reads, updates or deletes", async () => {
    const listedForB = await api("GET", "/platform/api/v1/masters/staff", { cookie: memberB() });
    expect((listedForB.json.items ?? []).map((i) => i.id)).toEqual(["staff-b1"]);
    expect(
      (await api("GET", "/platform/api/v1/masters/staff/staff-tt", { cookie: memberB() })).status,
    ).toBe(404);
    expect(
      (
        await api("PUT", "/platform/api/v1/masters/staff/staff-tt", {
          cookie: memberB(),
          body: {
            name: "乗っ取り",
            shortName: "乗",
            sortOrder: 1,
            active: true,
            personId: null,
            revision: 1,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("DELETE", "/platform/api/v1/masters/staff/staff-tt", {
          cookie: memberB(),
          body: { revision: 1 },
        })
      ).status,
    ).toBe(404);
    // A class in A cannot point at a grade that exists only in B, and
    // the reverse reference direction is refused too.
    await api("POST", "/platform/api/v1/masters/grades", {
      cookie: memberB(),
      body: { id: "grade-b", name: "B学年", sortOrder: 1, stage: null },
    });
    expect(
      (
        await api("POST", "/platform/api/v1/masters/classes", {
          cookie: editorA(),
          body: { id: "class-cross", gradeId: "grade-b", name: "越境", sortOrder: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a stale revision with 409 and the latest record", async () => {
    const conflict = await api("PUT", "/platform/api/v1/masters/day-patterns/pattern-1", {
      cookie: editorA(),
      body: { ...PATTERN_1, revision: 1 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.latest).toMatchObject({ id: "pattern-1", revision: 2 });
    const staleDelete = await api("DELETE", "/platform/api/v1/masters/day-patterns/pattern-1", {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(staleDelete.status).toBe(409);
  });

  it("records creates, updates and deletes in the outbox", async () => {
    const created = await api("POST", "/platform/api/v1/masters/grades", {
      cookie: editorA(),
      body: { id: "grade-outbox", name: "記録用", sortOrder: 99, stage: null },
    });
    expect(created.status).toBe(201);
    await api("PUT", "/platform/api/v1/masters/grades/grade-outbox", {
      cookie: editorA(),
      body: { id: "grade-outbox", name: "記録用2", sortOrder: 99, stage: null, revision: 1 },
    });
    await api("DELETE", "/platform/api/v1/masters/grades/grade-outbox", {
      cookie: editorA(),
      body: { revision: 2 },
    });
    const changes = await changeStore.listChanges(A, 0, 500);
    const mine = changes.filter((c) => c.kind === "grade" && c.entityId === "grade-outbox");
    expect(mine.map((c) => [c.op, c.revision])).toEqual([
      ["upsert", 1],
      ["upsert", 2],
      ["delete", 3],
    ]);
    expect(mine[0]?.actor).toEqual({ userId: "person-editor", via: "platform" });
  });

  it("refuses a membership whose teacher_id names another school's staff member", async () => {
    // person-outsider holds no membership anywhere, so only the
    // composite foreign key can refuse this row.
    await expect(
      db.insert(memberships).values({
        id: "membership-cross",
        schoolId: A,
        personId: "person-outsider",
        status: "approved",
        teacherId: "staff-b1",
      }),
    ).rejects.toThrow();
    const linked = await db
      .insert(memberships)
      .values({
        id: "membership-linked",
        schoolId: B,
        personId: "person-outsider",
        status: "approved",
        teacherId: "staff-b1",
      })
      .returning();
    expect(linked[0]?.teacherId).toBe("staff-b1");
  });

  it("rejects invalid input with 400", async () => {
    expect(
      (
        await api("POST", "/platform/api/v1/masters/day-patterns", {
          cookie: editorA(),
          body: {
            id: "pattern-bad",
            name: "壊れた日課",
            kind: "normal",
            periods: [
              { period: 1, label: "1限", startsAt: "09:40", endsAt: "08:50" },
              { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
            ],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", "/platform/api/v1/masters/staff", {
          cookie: editorA(),
          body: { ...STAFF_1, schoolId: B },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", "/platform/api/v1/masters/staff", {
          cookie: editorA(),
          body: {
            id: "staff-noactive",
            name: "無効未指定",
            shortName: "無",
            sortOrder: 3,
            personId: null,
          },
        })
      ).status,
    ).toBe(400);
  });
});
