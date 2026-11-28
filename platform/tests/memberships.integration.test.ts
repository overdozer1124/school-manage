import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient, GoogleProfile } from "../src/auth/google.js";
import { hashPassword } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { createMembershipAdminStore } from "../src/db/membershipAdmin.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditLog, memberships, persons, productRoles, staffMembers } from "../src/db/schema.js";
import { setupSchool } from "../src/db/setup.js";

// Membership administration tests (Issue #128) against a real
// Postgres and the real HTTP app, with a fake Google client. The two
// schools and their administrators come from the Issue #127 setup
// command, so the first administrator of each school is real.
// Runs only when PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const SECRET = "integration-test-secret";
const ADMIN_A = "admin-a@example.jp";
const ADMIN_B = "admin-b@example.jp";
const ADMIN2 = "admin2@example.jp";
const TEACHER = "teacher@example.jp";
const LEAVER = "leaver@example.jp";
const EDITOR = "editor@example.jp";
const VIEWER = "viewer@example.jp";
const DUAL = "dual@example.jp";
const MOVED = "moved@example.jp";

let fakeProfile: GoogleProfile = {
  googleId: "google-admin-a",
  email: ADMIN_A,
  emailVerified: true,
  name: "管理者A",
};
const fakeGoogle: GoogleAuthClient = {
  async exchangeCode(code) {
    if (code === "bad-code") throw new Error("invalid_grant");
    return { idToken: "fake-id-token" };
  },
  async verifyIdToken() {
    return fakeProfile;
  },
};

describe.skipIf(!url)("membership administration (Issue #128)", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let server: Server;
  let baseUrl: string;
  let schoolA = "";
  let schoolB = "";
  let adminAPersonId = "";
  let teacherMembershipId = "";
  let teacherPersonId = "";
  let editorMembershipId = "";
  let editorPersonId = "";

  interface MemberBody {
    membershipId?: string;
    personId?: string;
    email?: string;
    status?: string;
    approvedBy?: string | null;
    startsOn?: string | null;
    endsOn?: string | null;
    teacherId?: string | null;
    roles?: { product: string; role: string }[];
    items?: MemberBody[];
    error?: string;
    success?: boolean;
    passwordChangeRequired?: boolean;
    userId?: string;
    role?: string;
    school?: { schoolId: string };
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: MemberBody; setCookie: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as MemberBody,
      setCookie: res.headers.get("set-cookie") ?? "",
    };
  }

  function cookieOf(setCookie: string): string {
    return setCookie.split(";")[0] as string;
  }

  async function googleLogin(email: string, googleId: string): Promise<string> {
    const res = await googleLoginRaw(email, googleId);
    expect(res.status).toBe(200);
    return cookieOf(res.setCookie);
  }

  async function googleLoginRaw(
    email: string,
    googleId: string,
  ): Promise<{ status: number; setCookie: string }> {
    fakeProfile = { googleId, email, emailVerified: true, name: "ログイン者" };
    const urlRes = await request("POST", "/platform/api/v1/auth/google/url", {
      redirectUri: "http://localhost/callback",
    });
    expect(urlRes.status).toBe(200);
    const state = (urlRes.json as unknown as { state?: string }).state;
    const callback = await request(
      "POST",
      "/platform/api/v1/auth/google/callback",
      { code: "fake-code", state, redirectUri: "http://localhost/callback" },
      { cookie: cookieOf(urlRes.setCookie) },
    );
    return callback;
  }

  async function passwordLogin(email: string, password: string): Promise<string> {
    const res = await request("POST", "/platform/api/v1/auth/login", { email, password });
    expect(res.status).toBe(200);
    return cookieOf(res.setCookie);
  }

  async function adminCookieA(): Promise<string> {
    return googleLogin(ADMIN_A, "google-admin-a");
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

    const a = await setupSchool(db, {
      slug: "school-a",
      schoolName: "A校",
      adminEmail: ADMIN_A,
      adminName: "管理者A",
    });
    schoolA = a.schoolId;
    adminAPersonId = a.adminPersonId;
    const b = await setupSchool(db, {
      slug: "school-b",
      schoolName: "B校",
      adminEmail: ADMIN_B,
      adminName: "管理者B",
    });
    schoolB = b.schoolId;

    const config = loadAuthConfig({
      JWT_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    });
    const app = createApp({
      auth: { store: createAuthStore(db), config, googleClient: fakeGoogle },
      members: {
        config,
        authStore: createAuthStore(db),
        membershipStore: createMembershipAdminStore(db),
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server has no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await queryClient.end();
  });

  it("runs the full flow: invite, first login refused, approve, sign in, set password, password login", async () => {
    const admin = await adminCookieA();

    const invite = await request(
      "POST",
      "/platform/api/v1/members/invite",
      { email: TEACHER, name: "教員一郎", roles: [{ product: "schedule", role: "Editor" }] },
      { cookie: admin },
    );
    expect(invite.status).toBe(201);
    expect(invite.json.status).toBe("invited");
    expect(invite.json.email).toBe(TEACHER);
    expect(invite.json.roles).toEqual([{ product: "schedule", role: "Editor" }]);
    expect(invite.json.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    teacherMembershipId = invite.json.membershipId as string;
    teacherPersonId = invite.json.personId as string;

    // The same person cannot be invited twice over an overlapping period.
    const duplicate = await request(
      "POST",
      "/platform/api/v1/members/invite",
      { email: TEACHER, roles: [] },
      { cookie: admin },
    );
    expect(duplicate.status).toBe(409);

    // The invited person is refused at login until approved (D-2).
    const refused = await googleLoginRaw(TEACHER, "google-teacher-1");
    expect(refused.status).toBe(403);

    const approve = await request(
      "POST",
      `/platform/api/v1/members/${teacherMembershipId}/approve`,
      {},
      { cookie: admin },
    );
    expect(approve.status).toBe(200);
    expect(approve.json.status).toBe("approved");
    expect(approve.json.approvedBy).toBe(adminAPersonId);

    // First sign-in (Google) now succeeds, the one school is chosen
    // automatically, and the product context answers with the role.
    const teacher = await googleLogin(TEACHER, "google-teacher-1");
    const context = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      {
        cookie: teacher,
      },
    );
    expect(context.status).toBe(200);
    expect(context.json.userId).toBe(teacherPersonId);
    expect(context.json.role).toBe("Editor");

    // The ported setPassword: the invited person sets the password
    // for the password login inside their first session.
    const set = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "teacher-pass-1" },
      { cookie: teacher },
    );
    expect(set.status).toBe(200);
    expect(set.json.success).toBe(true);

    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: TEACHER,
      password: "teacher-pass-1",
    });
    expect(login.status).toBe(200);
    expect(login.json.school?.schoolId).toBe(schoolA);

    const auditRows = await db.select().from(auditLog);
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("membership.invite");
    expect(actions).toContain("membership.approve");
    expect(actions).toContain("auth.password.set");
  });

  it("keeps schools apart: another school's administrator cannot list or change the membership", async () => {
    const adminB = await googleLogin(ADMIN_B, "google-admin-b");

    const list = await request("GET", "/platform/api/v1/members", undefined, { cookie: adminB });
    expect(list.status).toBe(200);
    const items = list.json.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.email).toBe(ADMIN_B);
    expect(items.some((i) => i.membershipId === teacherMembershipId)).toBe(false);

    for (const attempt of [
      () =>
        request(
          "POST",
          `/platform/api/v1/members/${teacherMembershipId}/approve`,
          {},
          { cookie: adminB },
        ),
      () =>
        request(
          "POST",
          `/platform/api/v1/members/${teacherMembershipId}/suspend`,
          {},
          { cookie: adminB },
        ),
      () =>
        request(
          "POST",
          `/platform/api/v1/members/${teacherMembershipId}/end`,
          { endsOn: "2030-03-31" },
          { cookie: adminB },
        ),
      () =>
        request(
          "PUT",
          `/platform/api/v1/members/${teacherMembershipId}/roles`,
          { product: "schedule", role: "Viewer" },
          { cookie: adminB },
        ),
      () =>
        request(
          "PUT",
          `/platform/api/v1/members/${teacherMembershipId}/teacher`,
          { teacherId: null },
          { cookie: adminB },
        ),
    ]) {
      const res = await attempt();
      expect(res.status).toBe(404);
    }
    expect(schoolB).not.toBe("");
  });

  it("refuses people who are not administrators of the school", async () => {
    // An Editor and a Viewer of school A, seeded directly with
    // passwords so they can sign in.
    await db.insert(persons).values([
      {
        id: "p-editor-a",
        email: EDITOR,
        displayName: "編集者",
        passwordHash: await hashPassword("editor-pass-1"),
      },
      {
        id: "p-viewer-a",
        email: VIEWER,
        displayName: "閲覧者",
        passwordHash: await hashPassword("viewer-pass-1"),
      },
    ]);
    editorPersonId = "p-editor-a";
    await db.insert(memberships).values([
      { id: "m-editor-a", schoolId: schoolA, personId: "p-editor-a", status: "approved" },
      { id: "m-viewer-a", schoolId: schoolA, personId: "p-viewer-a", status: "approved" },
    ]);
    editorMembershipId = "m-editor-a";
    await db.insert(productRoles).values([
      {
        id: "r-editor-a",
        schoolId: schoolA,
        membershipId: "m-editor-a",
        product: "schedule",
        role: "Editor",
      },
      {
        id: "r-viewer-a",
        schoolId: schoolA,
        membershipId: "m-viewer-a",
        product: "schedule",
        role: "Viewer",
      },
    ]);

    const editor = await passwordLogin(EDITOR, "editor-pass-1");
    const listAsEditor = await request("GET", "/platform/api/v1/members", undefined, {
      cookie: editor,
    });
    expect(listAsEditor.status).toBe(403);
    const inviteAsEditor = await request(
      "POST",
      "/platform/api/v1/members/invite",
      { email: "nobody@example.jp", roles: [] },
      { cookie: editor },
    );
    expect(inviteAsEditor.status).toBe(403);

    const viewer = await passwordLogin(VIEWER, "viewer-pass-1");
    const listAsViewer = await request("GET", "/platform/api/v1/members", undefined, {
      cookie: viewer,
    });
    expect(listAsViewer.status).toBe(403);

    const anonymous = await request("GET", "/platform/api/v1/members");
    expect(anonymous.status).toBe(401);
    expect(editorMembershipId).not.toBe("");
    expect(editorPersonId).toBe("p-editor-a");
  });

  it("refuses to suspend, end or de-role the school's last administrator", async () => {
    const admin = await adminCookieA();
    const list = await request("GET", "/platform/api/v1/members", undefined, { cookie: admin });
    const own = (list.json.items ?? []).find((i) => i.email === ADMIN_A);
    expect(own).toBeDefined();
    const ownId = own?.membershipId as string;

    const suspend = await request(
      "POST",
      `/platform/api/v1/members/${ownId}/suspend`,
      {},
      { cookie: admin },
    );
    expect(suspend.status).toBe(409);
    const demote = await request(
      "PUT",
      `/platform/api/v1/members/${ownId}/roles`,
      { product: "schedule", role: "Viewer" },
      { cookie: admin },
    );
    expect(demote.status).toBe(409);
    const remove = await request(
      "PUT",
      `/platform/api/v1/members/${ownId}/roles`,
      { product: "schedule", role: null },
      { cookie: admin },
    );
    expect(remove.status).toBe(409);
    const end = await request(
      "POST",
      `/platform/api/v1/members/${ownId}/end`,
      { endsOn: "2030-03-31" },
      { cookie: admin },
    );
    expect(end.status).toBe(409);

    // With a second administrator approved, the first one can be
    // suspended — and the second administrator can bring them back.
    const invite = await request(
      "POST",
      "/platform/api/v1/members/invite",
      { email: ADMIN2, name: "管理者2", roles: [{ product: "schedule", role: "Admin" }] },
      { cookie: admin },
    );
    expect(invite.status).toBe(201);
    const secondId = invite.json.membershipId as string;
    const approve = await request(
      "POST",
      `/platform/api/v1/members/${secondId}/approve`,
      {},
      { cookie: admin },
    );
    expect(approve.status).toBe(200);

    const suspended = await request(
      "POST",
      `/platform/api/v1/members/${ownId}/suspend`,
      {},
      { cookie: admin },
    );
    expect(suspended.status).toBe(200);
    expect(suspended.json.status).toBe("suspended");

    const admin2 = await googleLogin(ADMIN2, "google-admin-2");
    const restored = await request(
      "POST",
      `/platform/api/v1/members/${ownId}/unsuspend`,
      {},
      { cookie: admin2 },
    );
    expect(restored.status).toBe(200);
    expect(restored.json.status).toBe("approved");
  });

  it("links a teacher id only to a staff member of the same school", async () => {
    await db.insert(staffMembers).values([
      {
        schoolId: schoolA,
        id: "staff-a-1",
        name: "教員一郎",
        shortName: "教一",
        sortOrder: 1,
        revision: 1,
        updatedBy: adminAPersonId,
        updatedVia: "platform",
      },
      {
        schoolId: schoolB,
        id: "staff-b-1",
        name: "B校教員",
        shortName: "B教",
        sortOrder: 1,
        revision: 1,
        updatedBy: adminAPersonId,
        updatedVia: "platform",
      },
    ]);
    const admin = await adminCookieA();

    const otherSchool = await request(
      "PUT",
      `/platform/api/v1/members/${teacherMembershipId}/teacher`,
      { teacherId: "staff-b-1" },
      { cookie: admin },
    );
    expect(otherSchool.status).toBe(400);

    const unknown = await request(
      "PUT",
      `/platform/api/v1/members/${teacherMembershipId}/teacher`,
      { teacherId: "staff-unknown" },
      { cookie: admin },
    );
    expect(unknown.status).toBe(400);

    const linked = await request(
      "PUT",
      `/platform/api/v1/members/${teacherMembershipId}/teacher`,
      { teacherId: "staff-a-1" },
      { cookie: admin },
    );
    expect(linked.status).toBe(200);
    expect(linked.json.teacherId).toBe("staff-a-1");

    // The link is what the session reports as the person's teacher id.
    const teacher = await googleLogin(TEACHER, "google-teacher-1");
    const me = await request("GET", "/platform/api/v1/auth/me", undefined, { cookie: teacher });
    expect(me.status).toBe(200);
    expect((me.json as unknown as { teacherId?: string | null }).teacherId).toBe("staff-a-1");

    const cleared = await request(
      "PUT",
      `/platform/api/v1/members/${teacherMembershipId}/teacher`,
      { teacherId: null },
      { cookie: admin },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.teacherId).toBeNull();
  });

  it("suspends and restores a member, and closes an enrolment with its end date", async () => {
    const admin = await adminCookieA();

    const suspended = await request(
      "POST",
      `/platform/api/v1/members/${editorMembershipId}/suspend`,
      {},
      { cookie: admin },
    );
    expect(suspended.status).toBe(200);
    const refusedLogin = await request("POST", "/platform/api/v1/auth/login", {
      email: EDITOR,
      password: "editor-pass-1",
    });
    expect(refusedLogin.status).toBe(403);

    const restored = await request(
      "POST",
      `/platform/api/v1/members/${editorMembershipId}/unsuspend`,
      {},
      { cookie: admin },
    );
    expect(restored.status).toBe(200);
    const editor = await passwordLogin(EDITOR, "editor-pass-1");
    expect(editor).toContain("platform_session=");

    // Ending an enrolment: the end date must not precede the start,
    // and once the period is over the person can no longer sign in.
    const invite = await request(
      "POST",
      "/platform/api/v1/members/invite",
      {
        email: LEAVER,
        name: "異動者",
        roles: [{ product: "schedule", role: "Viewer" }],
        startsOn: "2020-04-01",
      },
      { cookie: admin },
    );
    expect(invite.status).toBe(201);
    const leaverId = invite.json.membershipId as string;
    const approve = await request(
      "POST",
      `/platform/api/v1/members/${leaverId}/approve`,
      {},
      { cookie: admin },
    );
    expect(approve.status).toBe(200);

    const badEnd = await request(
      "POST",
      `/platform/api/v1/members/${leaverId}/end`,
      { endsOn: "2019-12-31" },
      { cookie: admin },
    );
    expect(badEnd.status).toBe(400);

    const ended = await request(
      "POST",
      `/platform/api/v1/members/${leaverId}/end`,
      { endsOn: "2020-09-30" },
      { cookie: admin },
    );
    expect(ended.status).toBe(200);
    expect(ended.json.endsOn).toBe("2020-09-30");

    const leaverLogin = await googleLoginRaw(LEAVER, "google-leaver-1");
    expect(leaverLogin.status).toBe(403);

    const endAgain = await request(
      "POST",
      `/platform/api/v1/members/${leaverId}/end`,
      { endsOn: "2021-03-31" },
      { cookie: admin },
    );
    expect(endAgain.status).toBe(409);
  });

  it("applies the setPassword rules: current password for the owner, administrator reset, others refused", async () => {
    const teacher = await passwordLogin(TEACHER, "teacher-pass-1");

    const tooShort = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "short" },
      { cookie: teacher },
    );
    expect(tooShort.status).toBe(400);

    const noCurrent = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "teacher-pass-2" },
      { cookie: teacher },
    );
    expect(noCurrent.status).toBe(400);

    const wrongCurrent = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { currentPassword: "not-the-password", newPassword: "teacher-pass-2" },
      { cookie: teacher },
    );
    expect(wrongCurrent.status).toBe(401);

    const changed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { currentPassword: "teacher-pass-1", newPassword: "teacher-pass-2" },
      { cookie: teacher },
    );
    expect(changed.status).toBe(200);
    await passwordLogin(TEACHER, "teacher-pass-2");

    // A school administrator resets a member's password without the
    // current one. Since Issue #140 the member cannot sign in with
    // it as-is: the login answers "change required" and hands out
    // only the change token, and the member's own change is what
    // makes the new password a normal credential.
    const admin = await adminCookieA();
    const reset = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: teacherPersonId, newPassword: "teacher-pass-3" },
      { cookie: admin },
    );
    expect(reset.status).toBe(200);
    const handedOver = await request("POST", "/platform/api/v1/auth/login", {
      email: TEACHER,
      password: "teacher-pass-3",
    });
    expect(handedOver.status).toBe(200);
    expect(handedOver.json.passwordChangeRequired).toBe(true);
    expect(handedOver.setCookie).toContain("platform_change=");
    expect(handedOver.setCookie).not.toContain("platform_session=");
    const changedByMember = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "teacher-pass-4" },
      { cookie: cookieOf(handedOver.setCookie) },
    );
    expect(changedByMember.status).toBe(200);
    await passwordLogin(TEACHER, "teacher-pass-4");

    // A non-administrator member of the same school may not.
    const editor = await passwordLogin(EDITOR, "editor-pass-1");
    const byEditor = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: teacherPersonId, newPassword: "teacher-pass-5" },
      { cookie: editor },
    );
    expect(byEditor.status).toBe(403);

    // Nor may another school's administrator: the person is not a
    // member of their school, so the target does not exist for them.
    const adminB = await googleLogin(ADMIN_B, "google-admin-b");
    const byAdminB = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: teacherPersonId, newPassword: "teacher-pass-5" },
      { cookie: adminB },
    );
    expect(byAdminB.status).toBe(404);
  });

  it("refuses the cross-school takeover: an invited person's password cannot be reset by the inviting school", async () => {
    const admin = await adminCookieA();

    // Step 1 of the attack the review demonstrated: school A's
    // administrator invites school B's administrator's address, with
    // no roles. An unapproved membership at school A now exists for
    // a person whose real membership is school B's.
    const invite = await request(
      "POST",
      "/platform/api/v1/members/invite",
      { email: ADMIN_B, roles: [] },
      { cookie: admin },
    );
    expect(invite.status).toBe(201);
    expect(invite.json.status).toBe("invited");
    const targetPersonId = invite.json.personId as string;

    // Step 2 is refused: the password belongs to the person, so
    // setting it here would hand school A's administrator the
    // password of a school B account.
    const attack = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: targetPersonId, newPassword: "takeover-pass-1" },
      { cookie: admin },
    );
    expect(attack.status).toBe(403);

    // The password was not set: the attempted password cannot sign
    // in (the person still has no password), so steps 3 and 4 of
    // the attack never happen.
    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: ADMIN_B,
      password: "takeover-pass-1",
    });
    expect(login.status).toBe(401);
  });

  it("refuses an administrator reset for a person who belongs to two schools", async () => {
    await db.insert(persons).values({
      id: "p-dual",
      email: DUAL,
      displayName: "兼務者",
      passwordHash: await hashPassword("dual-pass-1"),
    });
    await db.insert(memberships).values([
      { id: "m-dual-a", schoolId: schoolA, personId: "p-dual", status: "approved" },
      { id: "m-dual-b", schoolId: schoolB, personId: "p-dual", status: "approved" },
    ]);

    const admin = await adminCookieA();
    const reset = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: "p-dual", newPassword: "dual-pass-2" },
      { cookie: admin },
    );
    expect(reset.status).toBe(403);

    // The password is unchanged: the attempted one fails, the
    // original still signs in.
    const wrong = await request("POST", "/platform/api/v1/auth/login", {
      email: DUAL,
      password: "dual-pass-2",
    });
    expect(wrong.status).toBe(401);
    await passwordLogin(DUAL, "dual-pass-1");
  });

  it("refuses an administrator reset for a person whose other-school membership has ended", async () => {
    await db.insert(persons).values({
      id: "p-moved",
      email: MOVED,
      displayName: "異動済み",
      passwordHash: await hashPassword("moved-pass-1"),
    });
    await db.insert(memberships).values([
      {
        id: "m-moved-b",
        schoolId: schoolB,
        personId: "p-moved",
        status: "approved",
        startsOn: "2020-04-01",
        endsOn: "2021-03-31",
      },
      { id: "m-moved-a", schoolId: schoolA, personId: "p-moved", status: "approved" },
    ]);

    const admin = await adminCookieA();
    const reset = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: "p-moved", newPassword: "moved-pass-2" },
      { cookie: admin },
    );
    expect(reset.status).toBe(403);

    const wrong = await request("POST", "/platform/api/v1/auth/login", {
      email: MOVED,
      password: "moved-pass-2",
    });
    expect(wrong.status).toBe(401);
    // The original password still signs in, at school A only (the
    // school B enrolment is out of period).
    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: MOVED,
      password: "moved-pass-1",
    });
    expect(login.status).toBe(200);
    expect(login.json.school?.schoolId).toBe(schoolA);
  });
});
