import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import type { GoogleAuthClient } from "../src/auth/google.js";
import { hashPassword } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships, persons, schools } from "../src/db/schema.js";
import { tenantDb } from "../src/db/tenant.js";

// Membership periods (Issue #14): one row per enrolment period, the
// database refusing overlaps, and login working across a return.
// Runs only when PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const SECRET = "periods-test-secret";

const fakeGoogle: GoogleAuthClient = {
  async exchangeCode() {
    throw new Error("not used");
  },
  async verifyIdToken() {
    throw new Error("not used");
  },
};

describe.skipIf(!url)("membership periods", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let server: Server;
  let baseUrl: string;

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
        id: "p-return",
        email: "return@example.jp",
        displayName: "戻ってきた先生",
        passwordHash: await hashPassword("return-pass-1"),
      },
    ]);

    const config = loadAuthConfig({
      JWT_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    });
    const app = createApp({
      auth: { store: createAuthStore(db), config, googleClient: fakeGoogle },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queryClient.end();
  });

  it("keeps one row per enrolment period and refuses overlaps", async () => {
    const tdbA = tenantDb(db, A);

    // The first period, already over.
    await tdbA.insert(memberships, {
      id: "m-return-1",
      personId: "p-return",
      status: "approved",
      startsOn: "2020-04-01",
      endsOn: "2023-03-31",
      teacherId: "t-old",
    });
    // A gap period between the two stays is fine too.
    await tdbA.insert(memberships, {
      id: "m-return-gap",
      personId: "p-return",
      status: "approved",
      startsOn: "2024-04-01",
      endsOn: "2025-03-31",
    });
    // The current period, open-ended.
    await tdbA.insert(memberships, {
      id: "m-return-2",
      personId: "p-return",
      status: "approved",
      startsOn: "2025-04-01",
      endsOn: null,
      teacherId: "t-new",
    });

    // Overlapping the open-ended current period is refused.
    await expect(
      tdbA.insert(memberships, {
        id: "m-return-overlap",
        personId: "p-return",
        status: "approved",
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
      }),
    ).rejects.toThrow();
    // So is a fully open row, and one ending on the current start day
    // (the range is closed on both ends).
    await expect(
      tdbA.insert(memberships, {
        id: "m-return-open",
        personId: "p-return",
        status: "approved",
        startsOn: null,
        endsOn: null,
      }),
    ).rejects.toThrow();
    await expect(
      tdbA.insert(memberships, {
        id: "m-return-touch",
        personId: "p-return",
        status: "approved",
        startsOn: "2024-06-01",
        endsOn: "2025-04-01",
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(memberships);
    expect(rows.map((r) => r.id).sort()).toEqual(["m-return-1", "m-return-2", "m-return-gap"]);
  });

  it("logs a returned teacher in against the current period's row", async () => {
    const login = await fetch(`${baseUrl}/platform/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "return@example.jp", password: "return-pass-1" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

    const me = await fetch(`${baseUrl}/platform/api/v1/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { school?: { schoolId?: string }; teacherId?: string | null };
    expect(body.school?.schoolId).toBe(A);
    // The current row's teacher id, not the first period's.
    expect(body.teacherId).toBe("t-new");
  });
});
