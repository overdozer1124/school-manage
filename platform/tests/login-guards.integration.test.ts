import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient } from "../src/auth/google.js";
import { createLoginOAuthState } from "../src/auth/oauthState.js";
import { hashPassword } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditLog, memberships, persons, schools } from "../src/db/schema.js";
import { tenantDb } from "../src/db/tenant.js";

// Login guards (Issue #16): the password rate limit and the Google
// state's age and browser binding, at the HTTP surface. Each scenario
// builds its own app because the limiter lives in the router.
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const SECRET = "guards-test-secret";

const fakeGoogle: GoogleAuthClient = {
  async exchangeCode(code) {
    if (code !== "fake-code") throw new Error("bad code");
    return { idToken: "fake-id-token" };
  },
  async verifyIdToken() {
    return {
      googleId: "google-sub-guard",
      email: "google2@example.jp",
      emailVerified: true,
      name: "Google利用者2",
    };
  },
};

describe.skipIf(!url)("login guards", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  const servers: Server[] = [];

  async function makeApp(env: Record<string, string>): Promise<string> {
    const config = loadAuthConfig({
      JWT_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      ...env,
    });
    const app = createApp({
      auth: { store: createAuthStore(db), config, googleClient: fakeGoogle },
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    servers.push(server);
    const address = server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }

  async function post(
    baseUrl: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: { state?: string } | null; setCookie: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as { state?: string } | null,
      setCookie: res.headers.get("set-cookie") ?? "",
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

    await db.insert(schools).values([{ schoolId: A, slug: "school-a", name: "A校" }]);
    await db.insert(persons).values([
      {
        id: "p-rl-a",
        email: "rl-a@example.jp",
        displayName: "制限テストA",
        passwordHash: await hashPassword("rl-pass-a1"),
      },
      {
        id: "p-rl-b",
        email: "rl-b@example.jp",
        displayName: "制限テストB",
        passwordHash: await hashPassword("rl-pass-b1"),
      },
      {
        id: "p-google2",
        email: "google2@example.jp",
        displayName: "Google利用者2",
        googleId: "google-sub-guard",
      },
    ]);
    const tdbA = tenantDb(db, A);
    for (const [id, personId] of [
      ["m-rl-a", "p-rl-a"],
      ["m-rl-b", "p-rl-b"],
      ["m-google2", "p-google2"],
    ] as const) {
      await tdbA.insert(memberships, { id, personId, status: "approved" });
    }
  });

  afterAll(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await queryClient.end();
  });

  it("lets a correct password in before the limit is reached", async () => {
    const baseUrl = await makeApp({
      LOGIN_RATE_LIMIT_MAX_FAILURES: "3",
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
    const login = (password: string) =>
      post(baseUrl, "/platform/api/v1/auth/login", { email: "rl-a@example.jp", password });
    expect((await login("wrong-pass")).status).toBe(401);
    expect((await login("wrong-pass")).status).toBe(401);
    expect((await login("rl-pass-a1")).status).toBe(200);
  });

  it("answers 429 at the limit, audits it, and recovers after the window", async () => {
    const baseUrl = await makeApp({
      LOGIN_RATE_LIMIT_MAX_FAILURES: "3",
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: "2",
    });
    const login = (password: string) =>
      post(baseUrl, "/platform/api/v1/auth/login", { email: "rl-b@example.jp", password });
    expect((await login("wrong-pass")).status).toBe(401);
    expect((await login("wrong-pass")).status).toBe(401);
    expect((await login("wrong-pass")).status).toBe(401);
    expect((await login("wrong-pass")).status).toBe(429);
    // Even the right password is refused while the limit stands.
    expect((await login("rl-pass-b1")).status).toBe(429);

    const audits = await db.select().from(auditLog);
    expect(audits.some((row) => row.action === "auth.login.rate_limited")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect((await login("rl-pass-b1")).status).toBe(200);
  });

  it("does not lock out a school when failures come from one shared source", async () => {
    // Behind the proxy the teachers of one school share an outward
    // address. The per-source allowance (100) is far above the
    // per-email one (10), so ten different people mistyping once each
    // must not stop the next teacher from logging in.
    const baseUrl = await makeApp({
      TRUST_PROXY: "loopback",
      LOGIN_RATE_LIMIT_MAX_FAILURES: "10",
      LOGIN_RATE_LIMIT_IP_MAX_FAILURES: "100",
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
    const fromSchool = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 1; i <= 10; i += 1) {
      const res = await post(
        baseUrl,
        "/platform/api/v1/auth/login",
        { email: `ghost-${i}@example.jp`, password: "wrong-pass" },
        fromSchool,
      );
      expect(res.status).toBe(401);
    }
    const ok = await post(
      baseUrl,
      "/platform/api/v1/auth/login",
      { email: "rl-a@example.jp", password: "rl-pass-a1" },
      fromSchool,
    );
    expect(ok.status).toBe(200);
  });

  it("spends a Google state only in the browser that created it, and only while fresh", async () => {
    const baseUrl = await makeApp({});
    const urlRes = await post(baseUrl, "/platform/api/v1/auth/google/url", {
      redirectUri: "http://localhost/callback",
    });
    expect(urlRes.status).toBe(200);
    const state = urlRes.json?.state as string;
    const bindingCookie = (urlRes.setCookie ?? "").split(";")[0] as string;
    expect(bindingCookie.startsWith("platform_oauth=")).toBe(true);

    const callback = (headers: Record<string, string>, stateValue: string = state) =>
      post(
        baseUrl,
        "/platform/api/v1/auth/google/callback",
        { code: "fake-code", state: stateValue, redirectUri: "http://localhost/callback" },
        headers,
      );

    // No binding cookie at all.
    expect((await callback({})).status).toBe(403);
    // A cookie from another browser (a different value).
    expect((await callback({ cookie: "platform_oauth=someone-elses" })).status).toBe(403);
    // The browser that asked for the URL.
    const spent = await callback({ cookie: bindingCookie });
    expect(spent.status).toBe(200);
    // The successful response also clears the binding cookie: it is
    // single-use and must not linger in the browser.
    expect(spent.setCookie).toContain("platform_oauth=;");
    expect(spent.setCookie).toContain("Max-Age=0");

    // An expired state is refused even with its own binding cookie.
    const expiredBinding = "expired-binding-value";
    const expiredState = createLoginOAuthState(
      SECRET,
      undefined,
      expiredBinding,
      Date.now() - 11 * 60_000,
    );
    expect(
      (await callback({ cookie: `platform_oauth=${expiredBinding}` }, expiredState)).status,
    ).toBe(403);
  });
});
