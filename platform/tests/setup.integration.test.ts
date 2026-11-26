import { execFile } from "node:child_process";
import type { Server } from "node:http";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient, GoogleProfile } from "../src/auth/google.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  auditLog,
  memberships,
  persons,
  productEntitlements,
  productRoles,
  schools,
} from "../src/db/schema.js";
import { setupPlatformAdmin, setupSchool } from "../src/db/setup.js";

// First-run bootstrap tests (Issue #127) against a real Postgres and
// the real HTTP app, with a fake Google client. Runs only when
// PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const SECRET = "integration-test-secret";
const ADMIN_EMAIL = "admin@example.jp";
const CLI_ADMIN_EMAIL = "cli-admin@example.jp";

const execFileAsync = promisify(execFile);

let fakeProfile: GoogleProfile = {
  googleId: "google-admin-1",
  email: ADMIN_EMAIL,
  emailVerified: true,
  name: "管理者",
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

describe.skipIf(!url)("setup commands (Issue #127)", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let server: Server;
  let baseUrl: string;
  let schoolId = "";

  interface ApiBody {
    user?: { id: string };
    school?: { schoolId: string };
    userId?: string;
    role?: string;
    error?: string;
    authUrl?: string;
    state?: string;
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

  async function googleLogin(email: string, googleId: string): Promise<string> {
    fakeProfile = { googleId, email, emailVerified: true, name: "ログイン者" };
    const urlRes = await post("/platform/api/v1/auth/google/url", {
      redirectUri: "http://localhost/callback",
    });
    expect(urlRes.status).toBe(200);
    const callback = await post(
      "/platform/api/v1/auth/google/callback",
      { code: "fake-code", state: urlRes.json.state, redirectUri: "http://localhost/callback" },
      { cookie: cookieOf(urlRes.setCookie) },
    );
    expect(callback.status).toBe(200);
    return cookieOf(callback.setCookie);
  }

  async function counts() {
    const [s, p, m, r, e] = await Promise.all([
      db.select().from(schools),
      db.select().from(persons),
      db.select().from(memberships),
      db.select().from(productRoles),
      db.select().from(productEntitlements),
    ]);
    return {
      schools: s.length,
      persons: p.length,
      memberships: m.length,
      roles: r.length,
      entitlements: e.length,
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

  it("creates the first school and administrator, who can sign in and reach the schedule context", async () => {
    const result = await setupSchool(db, {
      slug: "first-school",
      schoolName: "第一学校",
      adminEmail: ADMIN_EMAIL,
      adminName: "管理者",
    });
    schoolId = result.schoolId;
    expect(result.adminCreated).toBe(true);

    // The person is registered by email only: no password, no Google
    // id, nothing secret for the command to print or log.
    const personRows = await db.select().from(persons);
    expect(personRows).toHaveLength(1);
    expect(personRows[0]?.passwordHash).toBeNull();
    expect(personRows[0]?.googleId).toBeNull();

    const auditRows = await db.select().from(auditLog);
    expect(auditRows.map((r) => r.action)).toContain("setup.school");

    // First sign-in is Google with the registered email (the platform
    // links the Google id on the verified email), the one school is
    // chosen automatically, and the schedule context answers 200 with
    // the Admin role instead of 403.
    const cookie = await googleLogin(ADMIN_EMAIL, "google-admin-1");
    const context = await get("/platform/api/v1/auth/context?product=schedule", { cookie });
    expect(context.status).toBe(200);
    expect(context.json.userId).toBe(result.adminPersonId);
    expect(context.json.role).toBe("Admin");

    const linked = await db.select().from(persons);
    expect(linked[0]?.googleId).toBe("google-admin-1");
  });

  it("refuses a second run with the same slug and changes nothing", async () => {
    const before = await counts();
    await expect(
      setupSchool(db, {
        slug: "first-school",
        schoolName: "別の学校",
        adminEmail: "other@example.jp",
        adminName: "別人",
      }),
    ).rejects.toThrow(/既に使われています/);
    expect(await counts()).toEqual(before);
  });

  it("runs as a CLI on an empty-schema database without printing any secret", async () => {
    const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
    const script = new URL("../src/setup/setupSchool.ts", import.meta.url).pathname;
    const env = { ...process.env, PLATFORM_DATABASE_URL: url as string };
    const args = [
      tsxCli,
      script,
      "--slug",
      "cli-school",
      "--name",
      "CLI学校",
      "--admin-email",
      CLI_ADMIN_EMAIL,
      "--admin-name",
      "CLI管理者",
    ];

    const { stdout, stderr } = await execFileAsync(process.execPath, args, { env });
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain("cli-school");
    expect(output).toContain(CLI_ADMIN_EMAIL);
    // No credential material exists to leak; assert the shapes anyway:
    // no JWT-looking string and no bearer token in the output.
    expect(output).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
    expect(output).not.toContain("Bearer");

    // The CLI-created administrator can also sign in and is Admin.
    const cookie = await googleLogin(CLI_ADMIN_EMAIL, "google-cli-admin-1");
    const context = await get("/platform/api/v1/auth/context?product=schedule", { cookie });
    expect(context.status).toBe(200);
    expect(context.json.role).toBe("Admin");

    // A repeated CLI run with the same slug fails cleanly.
    let failureCode: number | undefined;
    let failureStderr = "";
    await execFileAsync(process.execPath, args, { env }).catch(
      (err: { code?: number; stderr?: string }) => {
        failureCode = err.code;
        failureStderr = err.stderr ?? "";
      },
    );
    expect(failureCode).toBe(1);
    expect(failureStderr).toContain("既に使われています");
    const cliSchools = (await db.select().from(schools)).filter((s) => s.slug === "cli-school");
    expect(cliSchools).toHaveLength(1);
    expect(schoolId).not.toBe("");
  }, 60_000);

  it("adds a platform operator in the same shape and refuses a duplicate", async () => {
    const store = createAuthStore(db);
    const added = await setupPlatformAdmin(db, { email: "operator@example.jp", name: "運営者" });
    expect(added.personCreated).toBe(true);
    expect(await store.isPlatformAdmin(added.personId)).toBe(true);

    const auditRows = await db.select().from(auditLog);
    expect(auditRows.map((r) => r.action)).toContain("setup.platform_admin");

    await expect(
      setupPlatformAdmin(db, { email: "operator@example.jp", name: "運営者" }),
    ).rejects.toThrow(/既に運営者として登録されています/);

    // An existing person is reused, not duplicated.
    const reused = await setupPlatformAdmin(db, { email: ADMIN_EMAIL });
    expect(reused.personCreated).toBe(false);
    expect(await store.isPlatformAdmin(reused.personId)).toBe(true);
  });
});
