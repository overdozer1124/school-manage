import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

// Integration tests against a real Postgres (docker compose locally, the
// service container in CI). They run only when PLATFORM_DATABASE_URL is
// set; the repository root .env is loaded by vitest.config.ts, so a local
// run that follows the README does set it. In CI the variable must be
// set: the guard test below fails instead of letting the suite skip.
const platformUrl = process.env.PLATFORM_DATABASE_URL;
const scheduleUrl = process.env.SCHEDULE_DATABASE_URL;

const clients: ReturnType<typeof postgres>[] = [];
function connect(url: string) {
  const client = postgres(url, { max: 1, connect_timeout: 10 });
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
});

it("requires PLATFORM_DATABASE_URL in CI", () => {
  if (process.env.CI) {
    expect(platformUrl, "PLATFORM_DATABASE_URL must be set in CI").toBeTruthy();
  }
});

describe.skipIf(!platformUrl)("platform database", () => {
  it("connects and answers select 1", async () => {
    const sql = connect(platformUrl as string);
    const rows = await sql<{ value: number }[]>`select 1 as value`;
    expect(rows[0]?.value).toBe(1);
  });

  it("cannot connect to the schedule database with the platform credentials", async () => {
    const crossUrl = new URL(platformUrl as string);
    crossUrl.pathname = "/schedule";
    const sql = connect(crossUrl.toString());
    // Assert the failure is the permission refusal (SQLSTATE 42501), not
    // just any connection error: a wrong password, a missing database or
    // a different server must not let this test pass.
    const error: unknown = await sql`select 1`.then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("42501");
  });

  it.skipIf(!scheduleUrl)(
    "connects to the schedule database with the schedule credentials (control)",
    async () => {
      const sql = connect(scheduleUrl as string);
      const rows = await sql<{ value: number }[]>`select 1 as value`;
      expect(rows[0]?.value).toBe(1);
    },
  );
});
