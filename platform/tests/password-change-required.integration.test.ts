import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient, GoogleProfile } from "../src/auth/google.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { createMembershipAdminStore } from "../src/db/membershipAdmin.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditLog, persons } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { setupSchool } from "../src/db/setup.js";

// Password change required (Issue #140) against a real Postgres
// and the real HTTP app, with a fake Google client. A password an
// administrator set is a hand-over: while the person's
// passwordChangeRequired mark is on, a password login may only
// complete the person's own change — it never yields a session or
// a school — so the administrator's copy cannot open another
// school the person later joins.
// Runs only when PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const SECRET = "integration-test-secret";
const ADMIN_A = "admin-a140@example.jp";
const ADMIN_B = "admin-b140@example.jp";
const MEMBER = "member140@example.jp";
const SECOND = "second140@example.jp";
const GOOGLE_USER = "google140@example.jp";

let fakeProfile: GoogleProfile = {
  googleId: "google-admin-a140",
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

describe.skipIf(!url)("password change required (Issue #140)", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let server: Server;
  let baseUrl: string;
  let schoolA = "";
  let schoolB = "";
  let memberPersonId = "";

  interface Body {
    membershipId?: string;
    personId?: string;
    status?: string;
    error?: string;
    success?: boolean;
    passwordChangeRequired?: boolean;
    schoolSelectionRequired?: boolean;
    schoolId?: string;
    school?: { schoolId: string };
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Body; setCookie: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as Body,
      setCookie: res.headers.get("set-cookie") ?? "",
    };
  }

  function cookieOf(setCookie: string): string {
    return setCookie.split(";")[0] as string;
  }

  function cookieValue(setCookie: string, name: string): string {
    for (const part of setCookie.split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${name}=`)) {
        return trimmed.slice(name.length + 1).split(";")[0] as string;
      }
    }
    throw new Error(`cookie ${name} not in ${setCookie}`);
  }

  async function googleLogin(email: string, googleId: string): Promise<string> {
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
    expect(callback.status).toBe(200);
    return cookieOf(callback.setCookie);
  }

  async function inviteAndApprove(
    adminCookie: string,
    email: string,
    name: string,
  ): Promise<{ membershipId: string; personId: string }> {
    const invite = await request(
      "POST",
      "/platform/api/v1/members/invite",
      { email, name, roles: [{ product: "schedule", role: "Editor" }] },
      { cookie: adminCookie },
    );
    expect(invite.status).toBe(201);
    const approve = await request(
      "POST",
      `/platform/api/v1/members/${invite.json.membershipId}/approve`,
      {},
      { cookie: adminCookie },
    );
    expect(approve.status).toBe(200);
    return {
      membershipId: invite.json.membershipId as string,
      personId: invite.json.personId as string,
    };
  }

  async function flagOf(personId: string): Promise<boolean> {
    const rows = await db.select().from(persons).where(eq(persons.id, personId));
    return rows[0]?.passwordChangeRequired ?? false;
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
      slug: "school-a140",
      schoolName: "A校",
      adminEmail: ADMIN_A,
      adminName: "管理者A",
    });
    schoolA = a.schoolId;
    const b = await setupSchool(db, {
      slug: "school-b140",
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

  it("keeps the administrator who set a password out of a school the person later joins", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, MEMBER, "教員");
    memberPersonId = invited.personId;

    // The person sets their own first password in the Google
    // session: no mark, and the password login is a normal one.
    const memberGoogle = await googleLogin(MEMBER, "google-member140");
    const own = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "member-pass-1" },
      { cookie: memberGoogle },
    );
    expect(own.status).toBe(200);
    expect(await flagOf(memberPersonId)).toBe(false);
    const normal = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "member-pass-1",
    });
    expect(normal.status).toBe(200);
    expect(normal.json.school?.schoolId).toBe(schoolA);
    expect(normal.setCookie).toContain("platform_session=");

    // Step 1 of the Issue's scenario: school A's administrator sets
    // the person's password and knows it. The mark goes on.
    const reset = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: memberPersonId, newPassword: "admin-set-pass-1" },
      { cookie: adminA },
    );
    expect(reset.status).toBe(200);
    expect(await flagOf(memberPersonId)).toBe(true);

    // Step 2: the person is invited to school B and approved.
    const adminB = await googleLogin(ADMIN_B, "google-admin-b140");
    await inviteAndApprove(adminB, MEMBER, "教員");

    // Step 3: the administrator signs in with the password they
    // set, asking for school B. The credentials are right, so the
    // answer is not a refusal — but it is only the change step: no
    // session cookie, no school, nothing that opens school B.
    const attack = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "admin-set-pass-1",
      schoolId: schoolB,
    });
    expect(attack.status).toBe(200);
    expect(attack.json.passwordChangeRequired).toBe(true);
    expect(attack.json.school).toBeUndefined();
    expect(attack.setCookie).toContain("platform_change=");
    expect(attack.setCookie).not.toContain("platform_session=");
    const changeCookie = cookieOf(attack.setCookie);
    const changeToken = cookieValue(attack.setCookie, "platform_change");

    // The change cookie authenticates nothing else.
    const me = await request("GET", "/platform/api/v1/auth/me", undefined, {
      cookie: changeCookie,
    });
    expect(me.status).toBe(401);
    const select = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolB },
      { cookie: changeCookie },
    );
    expect(select.status).toBe(401);

    // Nor does the token itself, replayed where a session or a
    // selection token would go: it names a person, but it is not
    // either of those.
    const meReplay = await request("GET", "/platform/api/v1/auth/me", undefined, {
      cookie: `platform_session=${changeToken}`,
    });
    expect(meReplay.status).toBe(401);
    const contextReplay = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      { cookie: `platform_session=${changeToken}` },
    );
    expect(contextReplay.status).toBe(401);
    const selectReplay = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolB },
      { cookie: `platform_select=${changeToken}` },
    );
    expect(selectReplay.status).toBe(401);

    // The change token cannot change somebody else's password.
    const other = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: "somebody-else", newPassword: "member-pass-2" },
      { cookie: changeCookie },
    );
    expect(other.status).toBe(403);

    // The person themselves completes the change. From here the
    // password the administrator knew is dead.
    const completed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "member-pass-2" },
      { cookie: changeCookie },
    );
    expect(completed.status).toBe(200);
    expect(await flagOf(memberPersonId)).toBe(false);

    // The spent token does not work a second time.
    const reuse = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "member-pass-3" },
      { cookie: changeCookie },
    );
    expect(reuse.status).toBe(400);

    const dead = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "admin-set-pass-1",
    });
    expect(dead.status).toBe(401);

    // And the person's own new password reaches school B normally:
    // two candidate schools, a selection, then the session.
    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "member-pass-2",
    });
    expect(login.status).toBe(200);
    expect(login.json.schoolSelectionRequired).toBe(true);
    const chosen = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolB },
      { cookie: cookieOf(login.setCookie) },
    );
    expect(chosen.status).toBe(200);
    expect(chosen.json.school?.schoolId).toBe(schoolB);
    const context = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      { cookie: cookieOf(chosen.setCookie) },
    );
    expect(context.status).toBe(200);
    expect(context.json.schoolId).toBe(schoolB);
  });

  it("lets the person sign in normally once they have changed the password", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, SECOND, "教員2");

    // The administrator provides the first password (the person has
    // none yet): the mark goes on with it.
    const set = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: invited.personId, newPassword: "admin-set-second-1" },
      { cookie: adminA },
    );
    expect(set.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(true);

    const handedOver = await request("POST", "/platform/api/v1/auth/login", {
      email: SECOND,
      password: "admin-set-second-1",
    });
    expect(handedOver.status).toBe(200);
    expect(handedOver.json.passwordChangeRequired).toBe(true);
    expect(handedOver.setCookie).not.toContain("platform_session=");

    const completed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "second-pass-2" },
      { cookie: cookieOf(handedOver.setCookie) },
    );
    expect(completed.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(false);

    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: SECOND,
      password: "second-pass-2",
    });
    expect(login.status).toBe(200);
    expect(login.json.school?.schoolId).toBe(schoolA);
    expect(login.setCookie).toContain("platform_session=");
    const context = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      { cookie: cookieOf(login.setCookie) },
    );
    expect(context.status).toBe(200);

    // The forced change is audited, and no password is ever in the
    // audit summaries.
    const rows = await db.select().from(auditLog);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.login.password_change_required");
    expect(actions).toContain("auth.password.set");
    for (const row of rows) {
      expect(row.summary).not.toContain("admin-set-second-1");
      expect(row.summary).not.toContain("second-pass-2");
    }
  });

  it("does not gate Google login, and a self-service change there clears the mark", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, GOOGLE_USER, "教員3");
    const set = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: invited.personId, newPassword: "admin-set-google-1" },
      { cookie: adminA },
    );
    expect(set.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(true);

    // Google login proves the person's own account, which the
    // administrator holds nothing of: it proceeds as usual even
    // while the mark is on.
    const session = await googleLogin(GOOGLE_USER, "google-user140");
    const context = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      { cookie: session },
    );
    expect(context.status).toBe(200);

    // Changing the password themselves in that session (with the
    // current one, as an owner must) clears the mark.
    const changed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { currentPassword: "admin-set-google-1", newPassword: "google-pass-2" },
      { cookie: session },
    );
    expect(changed.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(false);

    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: GOOGLE_USER,
      password: "google-pass-2",
    });
    expect(login.status).toBe(200);
    expect(login.json.school?.schoolId).toBe(schoolA);
  });
});
