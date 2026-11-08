import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

// Integration tests against a real Postgres (docker compose locally, the
// service container in CI). They run only when PLATFORM_DATABASE_URL is
// set, so a checkout without a database still passes `pnpm test` for the
// pure checks; CI always sets the variable, so the checks always run there.
const platformUrl = process.env.PLATFORM_DATABASE_URL;

const clients: ReturnType<typeof postgres>[] = [];
function connect(url: string) {
  const client = postgres(url, { max: 1, connect_timeout: 10 });
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
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
    await expect(sql`select 1`).rejects.toThrow();
  });
});
