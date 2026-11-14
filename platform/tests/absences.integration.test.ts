import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAbsenceStore, createAbsenceSubdivisionStore } from "../src/db/absences.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createChangeStore, type ChangeStore } from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships, persons, productRoles, schools, staffMembers } from "../src/db/schema.js";

// Staff absences tests (Issue #25): the self-service rule (a member
// registers and edits only their own absences, always as tentative),
// confirmation by an Editor, the privacy of the leave subdivision
// (Admin and the person only), and two-school isolation. Runs only
// when PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SECRET = "absences-test-secret";
const ABSENCES = "/platform/api/v1/calendar/absences";
const SUBDIVISIONS = "/platform/api/v1/calendar/absence-subdivisions";
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

function absenceInput(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    staffId: "staff-1",
    fromDate: "2026-11-10",
    toDate: "2026-11-10",
    time: { kind: "all_day" },
    kind: "leave",
    subdivisionKey: null,
    purpose: null,
    note: null,
    certainty: "tentative",
    ...overrides,
  };
}

describe.skipIf(!url)("staff absences", () => {
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

  const adminA = () => sessionCookie("person-admin", A);
  const editorA = () => sessionCookie("person-editor", A);
  /** Viewer whose membership is linked to staff-1. */
  const teacher1A = () => sessionCookie("person-teacher1", A);
  /** Viewer whose membership is linked to staff-2. */
  const teacher2A = () => sessionCookie("person-teacher2", A);
  /** Viewer whose membership names no staff member. */
  const plainA = () => sessionCookie("person-plain", A);
  const editorB = () => sessionCookie("person-b", B);
  const outsiderA = () => sessionCookie("person-outsider", A);

  interface EntryJson {
    id?: string;
    revision?: number;
    certainty?: string;
    subdivisionKey?: string;
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
      { id: "person-admin", email: "admin@example.jp", displayName: "管理者" },
      { id: "person-editor", email: "editor@example.jp", displayName: "編集者" },
      { id: "person-teacher1", email: "teacher1@example.jp", displayName: "教員1" },
      { id: "person-teacher2", email: "teacher2@example.jp", displayName: "教員2" },
      { id: "person-plain", email: "plain@example.jp", displayName: "教員3" },
      { id: "person-b", email: "b@example.jp", displayName: "B校教員" },
      { id: "person-outsider", email: "outsider@example.jp", displayName: "部外者" },
    ]);
    // The staff of both schools (the shared master), written directly.
    // Both schools use the id "staff-1" — on purpose, for the
    // isolation tests.
    const staff = (schoolId: string, id: string, name: string, sortOrder: number) => ({
      schoolId,
      id,
      name,
      shortName: name,
      sortOrder,
      revision: 1,
      updatedBy: "person-editor",
      updatedVia: "platform" as const,
    });
    await db
      .insert(staffMembers)
      .values([
        staff(A, "staff-1", "教員1", 1),
        staff(A, "staff-2", "教員2", 2),
        staff(B, "staff-1", "B校教員1", 1),
        staff(B, "staff-b-only", "B校教員2", 2),
      ]);
    await db.insert(memberships).values([
      {
        id: "membership-admin-a",
        schoolId: A,
        personId: "person-admin",
        status: "approved",
        teacherId: null,
      },
      {
        id: "membership-editor-a",
        schoolId: A,
        personId: "person-editor",
        status: "approved",
        teacherId: null,
      },
      {
        id: "membership-teacher1-a",
        schoolId: A,
        personId: "person-teacher1",
        status: "approved",
        teacherId: "staff-1",
      },
      {
        id: "membership-teacher2-a",
        schoolId: A,
        personId: "person-teacher2",
        status: "approved",
        teacherId: "staff-2",
      },
      {
        id: "membership-plain-a",
        schoolId: A,
        personId: "person-plain",
        status: "approved",
        teacherId: null,
      },
      {
        id: "membership-b",
        schoolId: B,
        personId: "person-b",
        status: "approved",
        teacherId: "staff-1",
      },
    ]);
    await db.insert(productRoles).values([
      {
        id: "role-admin-schedule",
        schoolId: A,
        membershipId: "membership-admin-a",
        product: "schedule",
        role: "Admin",
      },
      {
        id: "role-editor-schedule",
        schoolId: A,
        membershipId: "membership-editor-a",
        product: "schedule",
        role: "Editor",
      },
      {
        id: "role-teacher1-schedule",
        schoolId: A,
        membershipId: "membership-teacher1-a",
        product: "schedule",
        role: "Viewer",
      },
      {
        id: "role-teacher2-schedule",
        schoolId: A,
        membershipId: "membership-teacher2-a",
        product: "schedule",
        role: "Viewer",
      },
      {
        id: "role-plain-schedule",
        schoolId: A,
        membershipId: "membership-plain-a",
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

    changeStore = createChangeStore(db);
    config = loadAuthConfig({ JWT_SECRET: SECRET });
    const app = createApp({
      absences: {
        config,
        authStore: createAuthStore(db),
        absenceStore: createAbsenceStore(db),
        subdivisionStore: createAbsenceSubdivisionStore(db),
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

  it("applies the default leave subdivisions once, insert-missing-only", async () => {
    const first = await api("POST", `${SUBDIVISIONS}/apply-defaults`, {
      cookie: editorA(),
      body: {},
    });
    expect(first.status).toBe(201);
    expect(first.json.items).toHaveLength(8);
    expect(first.json.items?.map((i) => i.label)).toEqual([
      "年休",
      "病休",
      "特休",
      "夏特",
      "看護",
      "職専免",
      "振休",
      "その他",
    ]);

    const second = await api("POST", `${SUBDIVISIONS}/apply-defaults`, {
      cookie: editorA(),
      body: {},
    });
    expect(second.status).toBe(201);
    expect(second.json.items).toHaveLength(0);

    const list = await api("GET", SUBDIVISIONS, { cookie: teacher1A() });
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(8);
  });

  it("refuses a Viewer who registers someone else's absence", async () => {
    const forOther = await api("POST", ABSENCES, {
      cookie: teacher2A(),
      body: absenceInput("abs-not-mine", { staffId: "staff-1" }),
    });
    expect(forOther.status).toBe(403);

    // A member whose membership names no staff member has no "own"
    // absence at all.
    const noTeacher = await api("POST", ABSENCES, {
      cookie: plainA(),
      body: absenceInput("abs-no-teacher", { staffId: "staff-1" }),
    });
    expect(noTeacher.status).toBe(403);

    const list = await api("GET", `${ABSENCES}?${NOVEMBER}`, { cookie: editorA() });
    expect(list.json.items?.map((i) => i.id)).not.toContain("abs-not-mine");
    expect(list.json.items?.map((i) => i.id)).not.toContain("abs-no-teacher");
  });

  it("stores a Viewer's own registration as tentative, even when it asks for confirmed", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: teacher1A(),
      body: absenceInput("abs-own-1", {
        subdivisionKey: "annual",
        certainty: "confirmed",
        purpose: null,
        note: "家庭の事情",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "abs-own-1",
      schoolId: A,
      staffId: "staff-1",
      kind: "leave",
      subdivisionKey: "annual",
      certainty: "tentative",
      createdBy: "person-teacher1",
      confirmedBy: null,
      confirmedAt: null,
      revision: 1,
    });

    // The write went through the #21 outbox.
    const changes = await changeStore.listChanges(A, 0, 200);
    expect(
      changes.some((c) => c.kind === "absence" && c.entityId === "abs-own-1" && c.revision === 1),
    ).toBe(true);
  });

  it("lets an Editor confirm a pending absence, and only an Editor", async () => {
    const pendingAsViewer = await api("GET", `${ABSENCES}/pending`, { cookie: teacher1A() });
    expect(pendingAsViewer.status).toBe(403);

    const pending = await api("GET", `${ABSENCES}/pending`, { cookie: editorA() });
    expect(pending.status).toBe(200);
    expect(pending.json.items?.map((i) => i.id)).toContain("abs-own-1");

    const confirmAsViewer = await api("POST", `${ABSENCES}/abs-own-1/confirm`, {
      cookie: teacher1A(),
      body: { revision: 1 },
    });
    expect(confirmAsViewer.status).toBe(403);

    const confirmed = await api("POST", `${ABSENCES}/abs-own-1/confirm`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.certainty).toBe("confirmed");
    expect(confirmed.json.confirmedBy).toBe("person-editor");
    expect(typeof confirmed.json.confirmedAt).toBe("string");
    expect(confirmed.json.revision).toBe(2);

    const pendingAfter = await api("GET", `${ABSENCES}/pending`, { cookie: editorA() });
    expect(pendingAfter.json.items?.map((i) => i.id)).not.toContain("abs-own-1");
  });

  it("returns a confirmed absence to tentative when its owner edits it", async () => {
    const edited = await api("PUT", `${ABSENCES}/abs-own-1`, {
      cookie: teacher1A(),
      body: absenceInput("abs-own-1", {
        subdivisionKey: "annual",
        certainty: "confirmed",
        note: "日程を変更",
        revision: 2,
      }),
    });
    expect(edited.status).toBe(200);
    expect(edited.json.certainty).toBe("tentative");
    expect(edited.json.confirmedBy).toBeNull();
    expect(edited.json.confirmedAt).toBeNull();
    expect(edited.json.revision).toBe(3);
  });

  it("lets an Editor edit a confirmed absence and keep it confirmed, stamps untouched", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-editor-1", {
        kind: "business_trip",
        certainty: "confirmed",
        purpose: "会議",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.json.certainty).toBe("confirmed");
    expect(created.json.confirmedBy).toBe("person-editor");
    expect(typeof created.json.confirmedAt).toBe("string");
    expect(created.json.revision).toBe(1);

    const edited = await api("PUT", `${ABSENCES}/abs-editor-1`, {
      cookie: editorA(),
      body: absenceInput("abs-editor-1", {
        kind: "business_trip",
        certainty: "confirmed",
        purpose: "会議（日程変更）",
        revision: 1,
      }),
    });
    expect(edited.status).toBe(200);
    expect(edited.json.certainty).toBe("confirmed");
    expect(edited.json.confirmedBy).toBe("person-editor");
    expect(edited.json.confirmedAt).toBe(created.json.confirmedAt);
    expect(edited.json.revision).toBe(2);

    const after = await api("GET", `${ABSENCES}/abs-editor-1`, { cookie: editorA() });
    expect(after.json.certainty).toBe("confirmed");
    expect(after.json.confirmedBy).toBe("person-editor");
    expect(after.json.confirmedAt).toBe(created.json.confirmedAt);
  });

  it("refuses a Viewer editing another's absence, or handing their own to someone else", async () => {
    const others = await api("PUT", `${ABSENCES}/abs-own-1`, {
      cookie: teacher2A(),
      body: absenceInput("abs-own-1", { staffId: "staff-2", revision: 3 }),
    });
    expect(others.status).toBe(403);

    const handover = await api("PUT", `${ABSENCES}/abs-own-1`, {
      cookie: teacher1A(),
      body: absenceInput("abs-own-1", { staffId: "staff-2", revision: 3 }),
    });
    expect(handover.status).toBe(403);

    const after = await api("GET", `${ABSENCES}/abs-own-1`, { cookie: editorA() });
    expect(after.json.staffId).toBe("staff-1");
    expect(after.json.revision).toBe(3);
  });

  it("returns the leave subdivision to an Admin and to the person, not to other staff", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-leave-1", {
        staffId: "staff-1",
        fromDate: "2026-11-16",
        toDate: "2026-11-16",
        subdivisionKey: "sick",
        certainty: "confirmed",
      }),
    });
    expect(created.status).toBe(201);
    // An Editor registering a confirmed absence stamps themselves.
    expect(created.json.confirmedBy).toBe("person-editor");

    const asAdmin = await api("GET", `${ABSENCES}/abs-leave-1`, { cookie: adminA() });
    expect(asAdmin.json.subdivisionKey).toBe("sick");

    const asSelf = await api("GET", `${ABSENCES}/abs-leave-1`, { cookie: teacher1A() });
    expect(asSelf.json.subdivisionKey).toBe("sick");

    const asOther = await api("GET", `${ABSENCES}/abs-leave-1`, { cookie: teacher2A() });
    expect(asOther.status).toBe(200);
    expect("subdivisionKey" in asOther.json).toBe(false);
    // The absence itself — who, when, that it is leave — stays
    // visible to staff for duty conflict checks.
    expect(asOther.json).toMatchObject({
      staffId: "staff-1",
      kind: "leave",
      certainty: "confirmed",
    });

    const listAsOther = await api("GET", `${ABSENCES}?${NOVEMBER}`, { cookie: teacher2A() });
    const item = listAsOther.json.items?.find((i) => i.id === "abs-leave-1");
    expect(item).toBeDefined();
    expect("subdivisionKey" in (item as EntryJson)).toBe(false);
  });

  it("hands no absence to a non-member, and requires a session at all", async () => {
    const outsider = await api("GET", `${ABSENCES}?${NOVEMBER}`, { cookie: outsiderA() });
    expect(outsider.status).toBe(403);

    const anonymous = await api("GET", `${ABSENCES}?${NOVEMBER}`, {});
    expect(anonymous.status).toBe(401);
  });

  it("keeps the two schools apart", async () => {
    const inB = await api("POST", ABSENCES, {
      cookie: editorB(),
      body: absenceInput("abs-b-1", { staffId: "staff-1", certainty: "confirmed" }),
    });
    expect(inB.status).toBe(201);
    expect(inB.json.schoolId).toBe(B);

    const listA = await api("GET", `${ABSENCES}?${NOVEMBER}`, { cookie: editorA() });
    expect(listA.json.items?.map((i) => i.id)).not.toContain("abs-b-1");

    const getFromA = await api("GET", `${ABSENCES}/abs-b-1`, { cookie: editorA() });
    expect(getFromA.status).toBe(404);

    // A staff id that exists only in school B is refused in A.
    const crossStaff = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-cross", { staffId: "staff-b-only" }),
    });
    expect(crossStaff.status).toBe(400);
  });

  it("refuses a subdivision the school has not defined under that kind", async () => {
    const unknown = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-unknown-sub", { subdivisionKey: "no_such_key" }),
    });
    expect(unknown.status).toBe(400);

    // "annual" is defined under leave, not under business_trip.
    const wrongKind = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-wrong-kind-sub", {
        kind: "business_trip",
        subdivisionKey: "annual",
      }),
    });
    expect(wrongKind.status).toBe(400);
  });

  it("lets a writer define a subdivision, use it, and keeps an in-use one from being deleted", async () => {
    const asViewer = await api("POST", SUBDIVISIONS, {
      cookie: teacher1A(),
      body: { id: "sub-denied", code: "business_trip", key: "denied", label: "不可" },
    });
    expect(asViewer.status).toBe(403);

    const defined = await api("POST", SUBDIVISIONS, {
      cookie: editorA(),
      body: { id: "sub-escort", code: "business_trip", key: "escort", label: "大会引率" },
    });
    expect(defined.status).toBe(201);
    expect(defined.json).toMatchObject({
      id: "sub-escort",
      code: "business_trip",
      key: "escort",
      label: "大会引率",
      revision: 1,
    });

    const used = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-trip-1", {
        kind: "business_trip",
        subdivisionKey: "escort",
        purpose: "県大会の引率",
        fromDate: "2026-11-21",
        toDate: "2026-11-21",
        time: { kind: "periods", from: 1, to: 6 },
      }),
    });
    expect(used.status).toBe(201);

    const deleteInUse = await api("DELETE", `${SUBDIVISIONS}/sub-escort`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(deleteInUse.status).toBe(409);

    const deleteAbsence = await api("DELETE", `${ABSENCES}/abs-trip-1`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(deleteAbsence.status).toBe(204);

    const deleteNow = await api("DELETE", `${SUBDIVISIONS}/sub-escort`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(deleteNow.status).toBe(204);
  });

  it("answers a stale update with a 409 whose latest hides the subdivision", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-conflict", {
        subdivisionKey: "annual",
        purpose: "私用",
        fromDate: "2026-11-24",
        toDate: "2026-11-24",
      }),
    });
    expect(created.status).toBe(201);

    const first = await api("PUT", `${ABSENCES}/abs-conflict`, {
      cookie: editorA(),
      body: absenceInput("abs-conflict", {
        subdivisionKey: "annual",
        purpose: "私用",
        fromDate: "2026-11-24",
        toDate: "2026-11-25",
        revision: 1,
      }),
    });
    expect(first.status).toBe(200);
    expect(first.json.revision).toBe(2);

    const stale = await api("PUT", `${ABSENCES}/abs-conflict`, {
      cookie: editorA(),
      body: absenceInput("abs-conflict", {
        subdivisionKey: "annual",
        fromDate: "2026-11-24",
        toDate: "2026-11-24",
        revision: 1,
      }),
    });
    expect(stale.status).toBe(409);
    expect(stale.json.latest).toBeDefined();
    expect(stale.json.latest?.revision).toBe(2);
    expect("subdivisionKey" in (stale.json.latest as Record<string, unknown>)).toBe(false);
    expect("purpose" in (stale.json.latest as Record<string, unknown>)).toBe(false);
  });

  it("returns only absences overlapping the range", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-range", {
        kind: "training",
        fromDate: "2026-11-10",
        toDate: "2026-11-12",
        time: { kind: "half_day", half: "am" },
      }),
    });
    expect(created.status).toBe(201);

    const before = await api("GET", `${ABSENCES}?from=2026-11-01&to=2026-11-09`, {
      cookie: editorA(),
    });
    expect(before.json.items?.map((i) => i.id)).not.toContain("abs-range");

    const touching = await api("GET", `${ABSENCES}?from=2026-11-12&to=2026-11-30`, {
      cookie: editorA(),
    });
    expect(touching.json.items?.map((i) => i.id)).toContain("abs-range");
  });

  it("lets only a writer delete an absence", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: teacher1A(),
      body: absenceInput("abs-delete", { fromDate: "2026-11-27", toDate: "2026-11-27" }),
    });
    expect(created.status).toBe(201);

    const asOwner = await api("DELETE", `${ABSENCES}/abs-delete`, {
      cookie: teacher1A(),
      body: { revision: 1 },
    });
    expect(asOwner.status).toBe(403);

    const asEditor = await api("DELETE", `${ABSENCES}/abs-delete`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(asEditor.status).toBe(204);

    const after = await api("GET", `${ABSENCES}/abs-delete`, { cookie: editorA() });
    expect(after.status).toBe(404);
  });

  it("answers the absence write-check with the save rule's own verdict, and writes nothing", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-check"),
    });
    expect(created.status).toBe(201);
    // A writer may write anyone's absence.
    expect(
      (await api("GET", `${ABSENCES}/abs-check/write-check`, { cookie: editorA() })).status,
    ).toBe(200);
    // The record's own person (a Viewer linked to staff-1) may
    // write their own.
    expect(
      (await api("GET", `${ABSENCES}/abs-check/write-check`, { cookie: teacher1A() })).status,
    ).toBe(200);
    // Another teacher may not write someone else's.
    expect(
      (await api("GET", `${ABSENCES}/abs-check/write-check`, { cookie: teacher2A() })).status,
    ).toBe(403);
    // A missing absence is a 404, another school's writer gets the
    // 404 too, and no session is a 401.
    expect(
      (await api("GET", `${ABSENCES}/abs-missing/write-check`, { cookie: editorA() })).status,
    ).toBe(404);
    expect(
      (await api("GET", `${ABSENCES}/abs-check/write-check`, { cookie: editorB() })).status,
    ).toBe(404);
    expect((await api("GET", `${ABSENCES}/abs-check/write-check`)).status).toBe(401);
    // The check wrote nothing: the record is still at revision 1.
    const read = await api("GET", `${ABSENCES}/abs-check`, { cookie: editorA() });
    expect(read.json.revision).toBe(1);
  });

  it("accepts an update sent in the read shape, as a move sends it", async () => {
    await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-move-shape", { purpose: "出張", note: "メモ" }),
    });
    // An Admin reads the full shape — the stamps and the
    // subdivision key included.
    const read = await api("GET", `${ABSENCES}/abs-move-shape`, { cookie: adminA() });
    expect(read.status).toBe(200);
    expect(read.json).toHaveProperty("subdivisionKey");
    // The schedule relay's move spreads that body whole and
    // replaces only the dates; the input schema ignores the
    // read-only fields (createdAt, confirmedBy, ...).
    const moved = await api("PUT", `${ABSENCES}/abs-move-shape`, {
      cookie: editorA(),
      body: { ...read.json, fromDate: "2026-11-12", toDate: "2026-11-13" },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.fromDate).toBe("2026-11-12");
    expect(moved.json.toDate).toBe("2026-11-13");
    expect(moved.json.revision).toBe(2);
  });
});
