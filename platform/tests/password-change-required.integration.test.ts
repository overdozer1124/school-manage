import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient, GoogleProfile } from "../src/auth/google.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { createMembershipAdminStore } from "../src/db/membershipAdmin.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditLog, persons } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { setupPlatformAdmin, setupSchool } from "../src/db/setup.js";

// Password change required and school scope (Issue #140) against a
// real Postgres and the real HTTP app, with a fake Google client.
// A password an administrator set is a hand-over: while the
// person's passwordChangeRequired mark is on, a password login may
// only complete the person's own change — it never yields a
// session or a school. And completing that change does not widen
// the password either: the password stays scoped to the school of
// the administrator who set it (an operator's reset scopes it to
// no school), because the administrator can walk the change step
// themselves. Only a re-set in a Google-login session — the one
// proof the administrator does not hold — lifts the scope.
// Runs only when PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const SECRET = "integration-test-secret";
const ADMIN_A = "admin-a140@example.jp";
const ADMIN_B = "admin-b140@example.jp";
const OPERATOR = "operator140@example.jp";
const MEMBER = "member140@example.jp";
const SECOND = "second140@example.jp";
const GOOGLE_USER = "google140@example.jp";
const THIRD = "third140@example.jp";
const OPERATOR_TARGET = "optarget140@example.jp";

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
  let config: AuthConfig;
  let schoolA = "";
  let schoolB = "";
  let operatorPersonId = "";
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
    schools?: { schoolId: string }[];
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

  // A Google login that ends in a session: when several schools are
  // candidates the callback answers with the selection step, which
  // this completes for the given school.
  async function googleSession(
    email: string,
    googleId: string,
    schoolId?: string,
  ): Promise<{ cookie: string; offered: string[] }> {
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
    const offered = (callback.json.schools ?? []).map((s) => s.schoolId);
    if (!callback.json.schoolSelectionRequired) {
      return { cookie: cookieOf(callback.setCookie), offered };
    }
    const chosen = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolId as string },
      { cookie: cookieOf(callback.setCookie) },
    );
    expect(chosen.status).toBe(200);
    return { cookie: cookieOf(chosen.setCookie), offered };
  }

  // A platform operator holds no session of their own (they belong
  // to no school), so the test signs the session token directly,
  // as the other integration suites do for their fixtures.
  function operatorCookie(): string {
    const token = signSessionToken(config, {
      personId: operatorPersonId,
      schoolId: schoolA,
      email: OPERATOR,
      authMethod: "password",
    });
    return `platform_session=${token}`;
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

  async function scopeOf(
    personId: string,
  ): Promise<{ restricted: boolean; schoolId: string | null }> {
    const rows = await db.select().from(persons).where(eq(persons.id, personId));
    return {
      restricted: rows[0]?.passwordScopeRestricted ?? false,
      schoolId: rows[0]?.passwordScopeSchoolId ?? null,
    };
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
    const operator = await setupPlatformAdmin(db, { email: OPERATOR, name: "運営者" });
    operatorPersonId = operator.personId;

    config = loadAuthConfig({
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

  it("keeps the administrator out of a later-joined school even when they complete the change step (approval first)", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, MEMBER, "教員");
    memberPersonId = invited.personId;

    // The person sets their own first password in the Google
    // session: no mark, no scope, and the password login is a
    // normal one.
    const memberGoogle = await googleLogin(MEMBER, "google-member140");
    const own = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "member-pass-1" },
      { cookie: memberGoogle },
    );
    expect(own.status).toBe(200);
    expect(await flagOf(memberPersonId)).toBe(false);
    expect(await scopeOf(memberPersonId)).toEqual({ restricted: false, schoolId: null });
    const normal = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "member-pass-1",
    });
    expect(normal.status).toBe(200);
    expect(normal.json.school?.schoolId).toBe(schoolA);
    expect(normal.setCookie).toContain("platform_session=");

    // Step 1 of the Issue's scenario: school A's administrator sets
    // the person's password and knows it. The mark goes on, and the
    // password is scoped to school A.
    const reset = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: memberPersonId, newPassword: "admin-set-pass-1" },
      { cookie: adminA },
    );
    expect(reset.status).toBe(200);
    expect(await flagOf(memberPersonId)).toBe(true);
    expect(await scopeOf(memberPersonId)).toEqual({ restricted: true, schoolId: schoolA });

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

    // The administrator now walks the change step themselves — the
    // hole the review demonstrated. The change completes and the
    // mark clears, but the scope does not move: the password they
    // chose is still confined to school A.
    const completedByAdmin = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "attacker-pass-9" },
      { cookie: changeCookie },
    );
    expect(completedByAdmin.status).toBe(200);
    expect(await flagOf(memberPersonId)).toBe(false);
    expect(await scopeOf(memberPersonId)).toEqual({ restricted: true, schoolId: schoolA });

    // The spent token does not work a second time.
    const reuse = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "attacker-pass-10" },
      { cookie: changeCookie },
    );
    expect(reuse.status).toBe(400);

    // Asking for school B with the changed password is refused:
    // no session is issued for an out-of-scope school.
    const attackB = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "attacker-pass-9",
      schoolId: schoolB,
    });
    expect(attackB.status).toBe(403);
    expect(attackB.setCookie).not.toContain("platform_session=");

    // Without naming a school, the only candidate the password can
    // see is school A: the session is for A directly, and school B
    // is not offered as a choice.
    const attackLogin = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "attacker-pass-9",
    });
    expect(attackLogin.status).toBe(200);
    expect(attackLogin.json.schoolSelectionRequired).toBeUndefined();
    expect(attackLogin.json.school?.schoolId).toBe(schoolA);
    const attackerSession = cookieOf(attackLogin.setCookie);

    // Nor can that session be switched to school B.
    const switchB = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolB },
      { cookie: attackerSession },
    );
    expect(switchB.status).toBe(403);

    // The password the administrator originally set is dead.
    const dead = await request("POST", "/platform/api/v1/auth/login", {
      email: MEMBER,
      password: "admin-set-pass-1",
    });
    expect(dead.status).toBe(401);

    // The person's own Google login is untouched by all of this:
    // both schools are offered, and school B opens.
    const personGoogle = await googleSession(MEMBER, "google-member140", schoolB);
    expect(personGoogle.offered.sort()).toEqual([schoolA, schoolB].sort());
    const context = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      { cookie: personGoogle.cookie },
    );
    expect(context.status).toBe(200);
    expect(context.json.schoolId).toBe(schoolB);
  });

  it("keeps the administrator out when the change step is completed before the second school approves", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, THIRD, "教員4");

    // The administrator provides the first password (the person has
    // none yet): the mark goes on, scoped to school A.
    const set = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: invited.personId, newPassword: "admin-set-third-1" },
      { cookie: adminA },
    );
    expect(set.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(true);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: schoolA });

    // The administrator completes the change step themselves,
    // before school B is involved at all.
    const handedOver = await request("POST", "/platform/api/v1/auth/login", {
      email: THIRD,
      password: "admin-set-third-1",
    });
    expect(handedOver.status).toBe(200);
    expect(handedOver.json.passwordChangeRequired).toBe(true);
    const completedByAdmin = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "attacker-pass-7" },
      { cookie: cookieOf(handedOver.setCookie) },
    );
    expect(completedByAdmin.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(false);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: schoolA });

    // Only now is the person invited to school B and approved.
    const adminB = await googleLogin(ADMIN_B, "google-admin-b140");
    await inviteAndApprove(adminB, THIRD, "教員4");

    // The changed password still cannot open school B, neither by
    // asking for it nor by choosing it after signing in.
    const attackB = await request("POST", "/platform/api/v1/auth/login", {
      email: THIRD,
      password: "attacker-pass-7",
      schoolId: schoolB,
    });
    expect(attackB.status).toBe(403);
    expect(attackB.setCookie).not.toContain("platform_session=");
    const attackLogin = await request("POST", "/platform/api/v1/auth/login", {
      email: THIRD,
      password: "attacker-pass-7",
    });
    expect(attackLogin.status).toBe(200);
    expect(attackLogin.json.school?.schoolId).toBe(schoolA);
    const switchB = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolB },
      { cookie: cookieOf(attackLogin.setCookie) },
    );
    expect(switchB.status).toBe(403);
  });

  it("lets the person sign in at the administrator's school once they have changed the password", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, SECOND, "教員2");

    // The administrator provides the first password (the person has
    // none yet): the mark goes on with it, scoped to school A.
    const set = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: invited.personId, newPassword: "admin-set-second-1" },
      { cookie: adminA },
    );
    expect(set.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(true);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: schoolA });

    const handedOver = await request("POST", "/platform/api/v1/auth/login", {
      email: SECOND,
      password: "admin-set-second-1",
    });
    expect(handedOver.status).toBe(200);
    expect(handedOver.json.passwordChangeRequired).toBe(true);
    expect(handedOver.setCookie).not.toContain("platform_session=");

    // The person themselves completes the change. The mark clears;
    // the scope stays — and school A is exactly what it allows.
    const completed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "second-pass-2" },
      { cookie: cookieOf(handedOver.setCookie) },
    );
    expect(completed.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(false);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: schoolA });

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

  it("does not gate Google login, and a self-service re-set there lifts the scope", async () => {
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
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: schoolA });

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

    // Re-setting the password themselves in that session (with the
    // current one, as an owner must) clears the mark and lifts the
    // scope: this is the one proof the administrator does not hold.
    const changed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { currentPassword: "admin-set-google-1", newPassword: "google-pass-2" },
      { cookie: session },
    );
    expect(changed.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(false);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: false, schoolId: null });

    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: GOOGLE_USER,
      password: "google-pass-2",
    });
    expect(login.status).toBe(200);
    expect(login.json.school?.schoolId).toBe(schoolA);

    // And once the person joins school B, the re-set password opens
    // it like any password the person chose themselves.
    const adminB = await googleLogin(ADMIN_B, "google-admin-b140");
    await inviteAndApprove(adminB, GOOGLE_USER, "教員3");
    const loginB = await request("POST", "/platform/api/v1/auth/login", {
      email: GOOGLE_USER,
      password: "google-pass-2",
    });
    expect(loginB.status).toBe(200);
    expect(loginB.json.schoolSelectionRequired).toBe(true);
    expect((loginB.json.schools ?? []).map((s) => s.schoolId).sort()).toEqual(
      [schoolA, schoolB].sort(),
    );
    const chosen = await request(
      "POST",
      "/platform/api/v1/auth/select-school",
      { schoolId: schoolB },
      { cookie: cookieOf(loginB.setCookie) },
    );
    expect(chosen.status).toBe(200);
    expect(chosen.json.school?.schoolId).toBe(schoolB);
  });

  it("scopes an operator-set password to no school at all", async () => {
    const adminA = await googleLogin(ADMIN_A, "google-admin-a140");
    const invited = await inviteAndApprove(adminA, OPERATOR_TARGET, "教員5");

    // A platform operator has no school of their own: their reset
    // marks the password and scopes it to no school.
    const set = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { personId: invited.personId, newPassword: "operator-set-1" },
      { cookie: operatorCookie() },
    );
    expect(set.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(true);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: null });

    // The person completes the forced change; the scope stays
    // empty, so the changed password opens nothing — not even the
    // school the person belongs to.
    const handedOver = await request("POST", "/platform/api/v1/auth/login", {
      email: OPERATOR_TARGET,
      password: "operator-set-1",
    });
    expect(handedOver.status).toBe(200);
    expect(handedOver.json.passwordChangeRequired).toBe(true);
    const completed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { newPassword: "optarget-pass-2" },
      { cookie: cookieOf(handedOver.setCookie) },
    );
    expect(completed.status).toBe(200);
    expect(await flagOf(invited.personId)).toBe(false);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: true, schoolId: null });
    const login = await request("POST", "/platform/api/v1/auth/login", {
      email: OPERATOR_TARGET,
      password: "optarget-pass-2",
    });
    expect(login.status).toBe(403);
    expect(login.setCookie).not.toContain("platform_session=");
    const loginA = await request("POST", "/platform/api/v1/auth/login", {
      email: OPERATOR_TARGET,
      password: "optarget-pass-2",
      schoolId: schoolA,
    });
    expect(loginA.status).toBe(403);

    // Google login is not the password: it opens school A as usual,
    // and the re-set made in that session lifts the scope.
    const session = await googleLogin(OPERATOR_TARGET, "google-optarget140");
    const context = await request(
      "GET",
      "/platform/api/v1/auth/context?product=schedule",
      undefined,
      { cookie: session },
    );
    expect(context.status).toBe(200);
    const changed = await request(
      "POST",
      "/platform/api/v1/auth/set-password",
      { currentPassword: "optarget-pass-2", newPassword: "optarget-pass-3" },
      { cookie: session },
    );
    expect(changed.status).toBe(200);
    expect(await scopeOf(invited.personId)).toEqual({ restricted: false, schoolId: null });
    const loginAfter = await request("POST", "/platform/api/v1/auth/login", {
      email: OPERATOR_TARGET,
      password: "optarget-pass-3",
    });
    expect(loginAfter.status).toBe(200);
    expect(loginAfter.json.school?.schoolId).toBe(schoolA);
  });
});
