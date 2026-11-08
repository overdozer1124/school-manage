import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient, GoogleProfile } from "../src/auth/google.js";
import { hashPassword } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditLog, persons, schools } from "../src/db/schema.js";
import { tenantDb } from "../src/db/tenant.js";
import { memberships } from "../src/db/schema.js";

// Login flow tests (Issue #5) against a real Postgres and the real HTTP
// app, with a fake Google client (the Issue allows a mock for Google).
// Runs only when PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SECRET = "integration-test-secret";

let fakeProfile: GoogleProfile = {
  googleId: "google-sub-1",
  email: "google@example.jp",
  name: "Google利用者",
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

describe.skipIf(!url)("auth API", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let server: Server;
  let baseUrl: string;

  interface ApiBody {
    token?: string;
    user?: { id: string };
    school?: { schoolId: string };
    schools?: { schoolId: string }[];
    schoolSelectionRequired?: boolean;
    error?: string;
    authUrl?: string;
    state?: string;
    schoolId?: string;
    teacherId?: string | null;
  }

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: ApiBody; setCookie: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as ApiBody,
      setCookie: res.headers.get("set-cookie") ?? "",
    };
  }

  async function get(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: ApiBody }> {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return { status: res.status, json: (await res.json().catch(() => null)) as ApiBody };
  }

  function cookieOf(setCookie: string): string {
    return setCookie.split(";")[0] as string;
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

    const pw = {
      single: await hashPassword("single-pass-1"),
      multi: await hashPassword("multi-pass-1"),
      invited: await hashPassword("invited-pass-1"),
      suspended: await hashPassword("suspended-pass-1"),
      ended: await hashPassword("ended-pass-1"),
      future: await hashPassword("future-pass-1"),
    };
    await db.insert(persons).values([
      {
        id: "p-single",
        email: "single@example.jp",
        displayName: "単一校",
        passwordHash: pw.single,
      },
      {
        id: "p-multi",
        email: "multi@example.jp",
        displayName: "二校所属",
        passwordHash: pw.multi,
      },
      {
        id: "p-invited",
        email: "invited@example.jp",
        displayName: "招待中",
        passwordHash: pw.invited,
      },
      {
        id: "p-suspended",
        email: "suspended@example.jp",
        displayName: "停止中",
        passwordHash: pw.suspended,
      },
      {
        id: "p-ended",
        email: "ended@example.jp",
        displayName: "期間終了",
        passwordHash: pw.ended,
      },
      {
        id: "p-future",
        email: "future@example.jp",
        displayName: "期間前",
        passwordHash: pw.future,
      },
      {
        id: "p-google",
        email: "google@example.jp",
        displayName: "Google利用者",
        googleId: "google-sub-1",
      },
      { id: "p-nopw", email: "nopw@example.jp", displayName: "パスワードなし" },
    ]);

    const tdbA = tenantDb(db, A);
    const tdbB = tenantDb(db, B);
    await tdbA.insert(memberships, {
      id: "m-single-a",
      personId: "p-single",
      status: "approved",
      teacherId: "t-1",
    });
    await tdbA.insert(memberships, { id: "m-multi-a", personId: "p-multi", status: "approved" });
    await tdbB.insert(memberships, { id: "m-multi-b", personId: "p-multi", status: "approved" });
    await tdbA.insert(memberships, { id: "m-invited-a", personId: "p-invited", status: "invited" });
    await tdbA.insert(memberships, {
      id: "m-suspended-a",
      personId: "p-suspended",
      status: "suspended",
    });
    await tdbA.insert(memberships, {
      id: "m-ended-a",
      personId: "p-ended",
      status: "approved",
      endsOn: "2000-01-01",
    });
    await tdbA.insert(memberships, {
      id: "m-future-a",
      personId: "p-future",
      status: "approved",
      startsOn: "2999-01-01",
    });
    await tdbB.insert(memberships, { id: "m-google-b", personId: "p-google", status: "approved" });
    await tdbA.insert(memberships, { id: "m-nopw-a", personId: "p-nopw", status: "approved" });

    const config = loadAuthConfig({
      JWT_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    });
    const app = createApp({
      auth: { store: createAuthStore(db), config, googleClient: fakeGoogle },
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

  it("logs in with a password, sets the shared cookie, and answers /me", async () => {
    const login = await post("/platform/api/v1/auth/login", {
      email: "single@example.jp",
      password: "single-pass-1",
    });
    expect(login.status).toBe(200);
    expect(login.json.user?.id).toBe("p-single");
    expect(login.json.school?.schoolId).toBe(A);
    expect(login.setCookie).toContain("platform_session=");
    expect(login.setCookie).toContain("HttpOnly");
    expect(login.setCookie).toContain("Secure");
    expect(login.setCookie).toContain("SameSite=Lax");
    expect(login.setCookie).toContain("Path=/");

    const me = await get("/platform/api/v1/auth/me", {
      cookie: cookieOf(login.setCookie),
    });
    expect(me.status).toBe(200);
    expect(me.json.user?.id).toBe("p-single");
    expect(me.json.school?.schoolId).toBe(A);
    expect(me.json.teacherId).toBe("t-1");
  });

  it("session tokens carry person and school but no role", async () => {
    const login = await post("/platform/api/v1/auth/login", {
      email: "single@example.jp",
      password: "single-pass-1",
    });
    const payload = jwt.verify(login.json.token ?? "", SECRET) as jwt.JwtPayload;
    expect(payload.personId).toBe("p-single");
    expect(payload.schoolId).toBe(A);
    expect("role" in payload).toBe(false);
  });

  it("rejects wrong passwords and unknown emails with 401", async () => {
    const wrong = await post("/platform/api/v1/auth/login", {
      email: "single@example.jp",
      password: "not-the-password",
    });
    expect(wrong.status).toBe(401);
    const unknown = await post("/platform/api/v1/auth/login", {
      email: "nobody@example.jp",
      password: "whatever-1",
    });
    expect(unknown.status).toBe(401);
    const nopw = await post("/platform/api/v1/auth/login", {
      email: "nopw@example.jp",
      password: "whatever-1",
    });
    expect(nopw.status).toBe(401);
    expect(nopw.json.error).toContain("パスワードが設定されていません");
  });

  it("logs out by clearing the cookie, and /me without a token is 401", async () => {
    const logout = await post("/platform/api/v1/auth/logout", {});
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toContain("platform_session=;");
    expect(logout.setCookie).toContain("Max-Age=0");
    const me = await get("/platform/api/v1/auth/me");
    expect(me.status).toBe(401);
  });

  it("asks a two-school person to choose, then lets them switch schools", async () => {
    const login = await post("/platform/api/v1/auth/login", {
      email: "multi@example.jp",
      password: "multi-pass-1",
    });
    expect(login.status).toBe(200);
    expect(login.json.schoolSelectionRequired).toBe(true);
    expect((login.json.schools ?? []).map((s) => s.schoolId).sort()).toEqual([A, B]);

    // A selection token alone does not open /me.
    const mePending = await get("/platform/api/v1/auth/me", {
      cookie: cookieOf(login.setCookie),
    });
    expect(mePending.status).toBe(401);

    const chosen = await post(
      "/platform/api/v1/auth/select-school",
      { schoolId: B },
      { cookie: cookieOf(login.setCookie) },
    );
    expect(chosen.status).toBe(200);
    expect(chosen.json.school?.schoolId).toBe(B);

    const switched = await post(
      "/platform/api/v1/auth/select-school",
      { schoolId: A },
      { cookie: cookieOf(chosen.setCookie) },
    );
    expect(switched.status).toBe(200);
    expect(switched.json.school?.schoolId).toBe(A);

    const me = await get("/platform/api/v1/auth/me", {
      cookie: cookieOf(switched.setCookie),
    });
    expect(me.status).toBe(200);
    expect(me.json.school?.schoolId).toBe(A);
  });

  it("honours an explicit schoolId at login and refuses a non-candidate school", async () => {
    const direct = await post("/platform/api/v1/auth/login", {
      email: "multi@example.jp",
      password: "multi-pass-1",
      schoolId: B,
    });
    expect(direct.status).toBe(200);
    expect(direct.json.school?.schoolId).toBe(B);

    const notCandidate = await post("/platform/api/v1/auth/login", {
      email: "single@example.jp",
      password: "single-pass-1",
      schoolId: B,
    });
    expect(notCandidate.status).toBe(403);
  });

  it("refuses invited, suspended and out-of-period memberships with 403", async () => {
    const cases = [
      {
        email: "invited@example.jp",
        password: "invited-pass-1",
      },
      {
        email: "suspended@example.jp",
        password: "suspended-pass-1",
      },
      {
        email: "ended@example.jp",
        password: "ended-pass-1",
      },
      {
        email: "future@example.jp",
        password: "future-pass-1",
      },
    ];
    for (const c of cases) {
      const res = await post("/platform/api/v1/auth/login", c);
      expect(res.status, c.email).toBe(403);
    }
  });

  it("runs the Google flow with a mocked Google and a signed state", async () => {
    fakeProfile = {
      googleId: "google-sub-1",
      email: "google@example.jp",
      name: "Google利用者",
    };
    const urlRes = await post("/platform/api/v1/auth/google/url", {
      redirectUri: "http://localhost/callback",
      schoolSlug: "school-b",
    });
    expect(urlRes.status).toBe(200);
    expect(urlRes.json.authUrl).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(urlRes.json.schoolId).toBe(B);

    const callback = await post("/platform/api/v1/auth/google/callback", {
      code: "fake-code",
      state: urlRes.json.state,
      redirectUri: "http://localhost/callback",
    });
    expect(callback.status).toBe(200);
    expect(callback.json.user?.id).toBe("p-google");
    expect(callback.json.school?.schoolId).toBe(B);
  });

  it("refuses a tampered OAuth state, an unregistered Google account and a bad code", async () => {
    const urlRes = await post("/platform/api/v1/auth/google/url", {
      redirectUri: "http://localhost/callback",
    });
    const tampered = (urlRes.json.state ?? "").replace("login-", "login-x");
    const badState = await post("/platform/api/v1/auth/google/callback", {
      code: "fake-code",
      state: tampered,
      redirectUri: "http://localhost/callback",
    });
    // The prefix survives this edit, so the state reaches the signature
    // check and is refused there (403), like the source's FORBIDDEN.
    expect(badState.status).toBe(403);
    const malformed = await post("/platform/api/v1/auth/google/callback", {
      code: "fake-code",
      state: "not-a-state",
      redirectUri: "http://localhost/callback",
    });
    expect(malformed.status).toBe(400);

    fakeProfile = {
      googleId: "google-sub-unknown",
      email: "stranger@example.jp",
      name: "未登録",
    };
    const stranger = await post("/platform/api/v1/auth/google/callback", {
      code: "fake-code",
      state: urlRes.json.state,
      redirectUri: "http://localhost/callback",
    });
    expect(stranger.status).toBe(403);

    fakeProfile = {
      googleId: "google-sub-1",
      email: "google@example.jp",
      name: "Google利用者",
    };
    const badCode = await post("/platform/api/v1/auth/google/callback", {
      code: "bad-code",
      state: urlRes.json.state,
      redirectUri: "http://localhost/callback",
    });
    expect(badCode.status).toBe(500);
  });

  it("rejects POSTs whose Origin does not match the host", async () => {
    const evil = await post(
      "/platform/api/v1/auth/login",
      {
        email: "single@example.jp",
        password: "single-pass-1",
      },
      { origin: "http://evil.example" },
    );
    expect(evil.status).toBe(403);
    const sameOrigin = await post(
      "/platform/api/v1/auth/login",
      {
        email: "single@example.jp",
        password: "single-pass-1",
      },
      { origin: baseUrl },
    );
    expect(sameOrigin.status).toBe(200);
  });

  it("writes audit rows for success and failure, without secrets", async () => {
    const rows = await db.select().from(auditLog);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.login.success");
    expect(actions).toContain("auth.login.failure");
    expect(actions).toContain("auth.google_login.success");
    for (const row of rows) {
      expect(row.summary).not.toContain("single-pass-1");
      expect(row.summary).not.toContain("multi-pass-1");
    }
  });
});
