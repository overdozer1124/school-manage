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
// and of a leave's purpose and note (Admin and the person only), and
// two-school isolation. Runs only when PLATFORM_DATABASE_URL is set
// (vitest.config).
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

  it("hides a leave absence's purpose and note from other staff, in reads and in write answers", async () => {
    // The Editor registers a leave for staff-1: the Editor is neither
    // an Admin nor the person, so even the create answer is shaped
    // without the private fields.
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-leave-texts", {
        staffId: "staff-1",
        fromDate: "2026-11-17",
        toDate: "2026-11-17",
        subdivisionKey: "sick",
        purpose: "通院",
        note: "家族の付き添い",
        certainty: "confirmed",
      }),
    });
    expect(created.status).toBe(201);
    expect("subdivisionKey" in created.json).toBe(false);
    expect("purpose" in created.json).toBe(false);
    expect("note" in created.json).toBe(false);

    const asOther = await api("GET", `${ABSENCES}/abs-leave-texts`, { cookie: teacher2A() });
    expect(asOther.status).toBe(200);
    expect("subdivisionKey" in asOther.json).toBe(false);
    expect("purpose" in asOther.json).toBe(false);
    expect("note" in asOther.json).toBe(false);
    expect(asOther.json).toMatchObject({ staffId: "staff-1", kind: "leave" });

    const asAdmin = await api("GET", `${ABSENCES}/abs-leave-texts`, { cookie: adminA() });
    expect(asAdmin.json.subdivisionKey).toBe("sick");
    expect(asAdmin.json.purpose).toBe("通院");
    expect(asAdmin.json.note).toBe("家族の付き添い");

    const asSelf = await api("GET", `${ABSENCES}/abs-leave-texts`, { cookie: teacher1A() });
    expect(asSelf.json.subdivisionKey).toBe("sick");
    expect(asSelf.json.purpose).toBe("通院");
    expect(asSelf.json.note).toBe("家族の付き添い");

    const listAsOther = await api("GET", `${ABSENCES}?${NOVEMBER}`, { cookie: teacher2A() });
    const item = listAsOther.json.items?.find((i) => i.id === "abs-leave-texts");
    expect(item).toBeDefined();
    expect("subdivisionKey" in (item as EntryJson)).toBe(false);
    expect("purpose" in (item as EntryJson)).toBe(false);
    expect("note" in (item as EntryJson)).toBe(false);

    // An update answer is shaped the same way for a caller who is
    // not the person the absence is about.
    const updated = await api("PUT", `${ABSENCES}/abs-leave-texts`, {
      cookie: editorA(),
      body: absenceInput("abs-leave-texts", {
        staffId: "staff-1",
        fromDate: "2026-11-17",
        toDate: "2026-11-17",
        subdivisionKey: "sick",
        purpose: "通院",
        note: "家族の付き添い（日程変更）",
        certainty: "confirmed",
        revision: 1,
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json.revision).toBe(2);
    expect("subdivisionKey" in updated.json).toBe(false);
    expect("purpose" in updated.json).toBe(false);
    expect("note" in updated.json).toBe(false);

    // The stored texts themselves are untouched by the shaping —
    // and untouched by this edit, too: the Editor cannot see them,
    // so the note they sent is not taken and the stored value
    // stands (a caller who cannot see a field cannot replace it).
    const afterAsSelf = await api("GET", `${ABSENCES}/abs-leave-texts`, { cookie: teacher1A() });
    expect(afterAsSelf.json.note).toBe("家族の付き添い");
  });

  it("keeps the fields an Editor cannot see when they edit another's leave", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: adminA(),
      body: absenceInput("abs-leave-carry", {
        staffId: "staff-1",
        fromDate: "2026-11-20",
        toDate: "2026-11-20",
        subdivisionKey: "sick",
        purpose: "通院",
        note: "家族の付き添い",
        certainty: "confirmed",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.json.revision).toBe(1);

    // The Editor is neither an Admin nor the person, so the full
    // record never reached them. A full-replace edit naming only
    // what they can see — the dates move — must still go through:
    // omitting the three hidden fields is not a 400.
    const datesOnly = await api("PUT", `${ABSENCES}/abs-leave-carry`, {
      cookie: editorA(),
      body: {
        id: "abs-leave-carry",
        staffId: "staff-1",
        fromDate: "2026-11-21",
        toDate: "2026-11-22",
        time: { kind: "all_day" },
        kind: "leave",
        certainty: "confirmed",
        revision: 1,
      },
    });
    expect(datesOnly.status).toBe(200);
    expect(datesOnly.json.fromDate).toBe("2026-11-21");
    expect(datesOnly.json.toDate).toBe("2026-11-22");
    expect(datesOnly.json.revision).toBe(2);

    // Sending nulls for the fields they cannot see does not clear
    // them either — the body's word on them is not taken.
    const withNulls = await api("PUT", `${ABSENCES}/abs-leave-carry`, {
      cookie: editorA(),
      body: absenceInput("abs-leave-carry", {
        staffId: "staff-1",
        fromDate: "2026-11-23",
        toDate: "2026-11-23",
        subdivisionKey: null,
        purpose: null,
        note: null,
        certainty: "confirmed",
        revision: 2,
      }),
    });
    expect(withNulls.status).toBe(200);
    expect(withNulls.json.revision).toBe(3);

    // All three hidden fields kept their stored values throughout.
    const asAdmin = await api("GET", `${ABSENCES}/abs-leave-carry`, { cookie: adminA() });
    expect(asAdmin.json.fromDate).toBe("2026-11-23");
    expect(asAdmin.json.subdivisionKey).toBe("sick");
    expect(asAdmin.json.purpose).toBe("通院");
    expect(asAdmin.json.note).toBe("家族の付き添い");
    expect(asAdmin.json.revision).toBe(3);
  });

  it("refuses an Editor who would expose a leave's hidden fields by changing its kind or its person", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: adminA(),
      body: absenceInput("abs-leave-retype", {
        staffId: "staff-1",
        fromDate: "2026-11-24",
        toDate: "2026-11-24",
        subdivisionKey: "sick",
        purpose: "通院",
        note: "家族の付き添い",
        certainty: "confirmed",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.json.revision).toBe(1);

    // The Editor cannot see the leave's subdivision, purpose or
    // note, so an edit by them carries the stored values over.
    // Turning the record into a business trip in the same save
    // would put those carried texts on display — a trip's texts
    // are visible to all staff — so the edit is refused.
    const retyped = await api("PUT", `${ABSENCES}/abs-leave-retype`, {
      cookie: editorA(),
      body: absenceInput("abs-leave-retype", {
        staffId: "staff-1",
        fromDate: "2026-11-24",
        toDate: "2026-11-24",
        kind: "business_trip",
        subdivisionKey: null,
        certainty: "confirmed",
        revision: 1,
      }),
    });
    expect(retyped.status).toBe(403);

    // Handing the record to another staff member is refused the
    // same way: the new person could then read the carried texts
    // as their own.
    const reassigned = await api("PUT", `${ABSENCES}/abs-leave-retype`, {
      cookie: editorA(),
      body: absenceInput("abs-leave-retype", {
        staffId: "staff-2",
        fromDate: "2026-11-24",
        toDate: "2026-11-24",
        subdivisionKey: "sick",
        certainty: "confirmed",
        revision: 1,
      }),
    });
    expect(reassigned.status).toBe(403);

    // Both refused edits left the stored record exactly as it was,
    // and the texts did not leak to the would-be new person either.
    const asAdmin = await api("GET", `${ABSENCES}/abs-leave-retype`, { cookie: adminA() });
    expect(asAdmin.json.kind).toBe("leave");
    expect(asAdmin.json.staffId).toBe("staff-1");
    expect(asAdmin.json.subdivisionKey).toBe("sick");
    expect(asAdmin.json.purpose).toBe("通院");
    expect(asAdmin.json.note).toBe("家族の付き添い");
    expect(asAdmin.json.revision).toBe(1);

    const asStaff2 = await api("GET", `${ABSENCES}/abs-leave-retype`, { cookie: teacher2A() });
    expect(asStaff2.status).toBe(200);
    expect("subdivisionKey" in asStaff2.json).toBe(false);
    expect("purpose" in asStaff2.json).toBe(false);
    expect("note" in asStaff2.json).toBe(false);

    // An Admin sees every field, so nothing is carried over for
    // them and they may still change the kind.
    const byAdmin = await api("PUT", `${ABSENCES}/abs-leave-retype`, {
      cookie: adminA(),
      body: absenceInput("abs-leave-retype", {
        staffId: "staff-1",
        fromDate: "2026-11-24",
        toDate: "2026-11-24",
        kind: "business_trip",
        subdivisionKey: null,
        purpose: "通院",
        note: "家族の付き添い",
        certainty: "confirmed",
        revision: 1,
      }),
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.json.kind).toBe("business_trip");
    expect(byAdmin.json.revision).toBe(2);
  });

  it("lets an Admin rewrite the hidden fields of a leave", async () => {
    const edited = await api("PUT", `${ABSENCES}/abs-leave-carry`, {
      cookie: adminA(),
      body: absenceInput("abs-leave-carry", {
        staffId: "staff-1",
        fromDate: "2026-11-23",
        toDate: "2026-11-23",
        subdivisionKey: "annual",
        purpose: "私用",
        note: "変更後のメモ",
        certainty: "confirmed",
        revision: 3,
      }),
    });
    expect(edited.status).toBe(200);
    expect(edited.json.subdivisionKey).toBe("annual");
    expect(edited.json.purpose).toBe("私用");
    expect(edited.json.note).toBe("変更後のメモ");
    expect(edited.json.revision).toBe(4);
  });

  it("hides a leave absence's texts in the pending list and in the confirm answer", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: teacher1A(),
      body: absenceInput("abs-leave-pending", {
        staffId: "staff-1",
        fromDate: "2026-11-18",
        toDate: "2026-11-18",
        subdivisionKey: "annual",
        purpose: "私用",
        note: "家族の用事",
      }),
    });
    expect(created.status).toBe(201);
    // The owner registering their own leave sees the texts.
    expect(created.json.purpose).toBe("私用");
    expect(created.json.note).toBe("家族の用事");

    const pending = await api("GET", `${ABSENCES}/pending`, { cookie: editorA() });
    const item = pending.json.items?.find((i) => i.id === "abs-leave-pending");
    expect(item).toBeDefined();
    expect("subdivisionKey" in (item as EntryJson)).toBe(false);
    expect("purpose" in (item as EntryJson)).toBe(false);
    expect("note" in (item as EntryJson)).toBe(false);

    const confirmed = await api("POST", `${ABSENCES}/abs-leave-pending/confirm`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.certainty).toBe("confirmed");
    expect("subdivisionKey" in confirmed.json).toBe(false);
    expect("purpose" in confirmed.json).toBe(false);
    expect("note" in confirmed.json).toBe(false);
  });

  it("keeps a business trip's purpose and note visible to other staff", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-trip-texts", {
        staffId: "staff-1",
        fromDate: "2026-11-19",
        toDate: "2026-11-19",
        kind: "business_trip",
        subdivisionKey: null,
        purpose: "県大会の引率",
        note: "バス手配済み",
        certainty: "confirmed",
      }),
    });
    expect(created.status).toBe(201);

    const asOther = await api("GET", `${ABSENCES}/abs-trip-texts`, { cookie: teacher2A() });
    expect(asOther.status).toBe(200);
    expect(asOther.json.purpose).toBe("県大会の引率");
    expect(asOther.json.note).toBe("バス手配済み");
    // The subdivision field is still absent from the public shape.
    expect("subdivisionKey" in asOther.json).toBe(false);

    const listAsOther = await api("GET", `${ABSENCES}?${NOVEMBER}`, { cookie: teacher2A() });
    const item = listAsOther.json.items?.find((i) => i.id === "abs-trip-texts");
    expect(item?.purpose).toBe("県大会の引率");
    expect(item?.note).toBe("バス手配済み");
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

  it("answers a stale update with a 409 whose latest hides the subdivision and the leave texts", async () => {
    const created = await api("POST", ABSENCES, {
      cookie: editorA(),
      body: absenceInput("abs-conflict", {
        subdivisionKey: "annual",
        purpose: "私用",
        note: "家族の事情",
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
    expect("note" in (stale.json.latest as Record<string, unknown>)).toBe(false);
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
});
