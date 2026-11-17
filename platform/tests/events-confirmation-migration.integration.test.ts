import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

// Migration test for Issue #85: a database that already holds
// events — some of them confirmed — must pass through the
// migration that adds confirmed_by / confirmed_at and the
// events_confirmation_stamps check. Events confirmed before the
// migration have no confirmation record; the migration stands
// their creator and creation moment in for the stamps, and
// tentative events keep both null. The pre-migration schema is
// built from a copy of the migration folder with the journal cut
// back to the absences migration (0008). Runs only when
// PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const DRIZZLE = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A copy of the migration folder that stops at 0008: the 0009
 *  SQL and snapshot are left out and the journal is trimmed. */
function folderBefore0009(): string {
  const dir = mkdtempSync(join(tmpdir(), "sm-drizzle-before-0009-"));
  cpSync(DRIZZLE, dir, { recursive: true });
  rmSync(join(dir, "0009_loose_hairball.sql"));
  rmSync(join(dir, "meta", "0009_snapshot.json"));
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 8);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  return dir;
}

describe.skipIf(!url)("event confirmation migration (Issue #85)", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let raw: ReturnType<typeof postgres>;
  let beforeDir: string;

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    db = created.db;
    queryClient = created.queryClient;
    raw = postgres(url as string, { max: 1 });

    // The schema as it stood before this Issue's migration.
    beforeDir = folderBefore0009();
    await runMigrations(db, beforeDir);

    // A school and two events of the old shape (no stamp columns
    // exist yet): one confirmed, one tentative.
    await raw`
      insert into schools (school_id, slug, name) values (${A}, 'school-a', 'A校')
    `;
    const insert = (id: string, certainty: string, createdBy: string, createdAt: string) =>
      raw`
        insert into events (
          school_id, id, title, kind, date_precision, starts_on, certainty,
          visibility, revision, created_by, updated_by, updated_via, created_at
        ) values (
          ${A}, ${id}, '行事', 'event', 'day', '2026-11-10', ${certainty},
          'guardian', 1, ${createdBy}, ${createdBy}, 'platform', ${createdAt}
        )
      `;
    await insert("ev-old-confirmed", "confirmed", "person-creator", "2026-04-05T08:30:00.000Z");
    await insert("ev-old-tentative", "tentative", "person-creator", "2026-04-06T08:30:00.000Z");
  });

  afterAll(async () => {
    rmSync(beforeDir, { recursive: true, force: true });
    await raw.end();
    await queryClient.end();
  });

  it("migrates existing data: confirmed events gain their creator and creation as the stamps", async () => {
    await runMigrations(db);

    const rows = await raw`
      select id, certainty, confirmed_by, confirmed_at
      from events where school_id = ${A} order by id
    `;
    expect(rows).toHaveLength(2);
    const confirmed = rows.find((r) => r["id"] === "ev-old-confirmed");
    expect(confirmed?.["certainty"]).toBe("confirmed");
    expect(confirmed?.["confirmed_by"]).toBe("person-creator");
    expect((confirmed?.["confirmed_at"] as Date).toISOString()).toBe("2026-04-05T08:30:00.000Z");
    const tentative = rows.find((r) => r["id"] === "ev-old-tentative");
    expect(tentative?.["certainty"]).toBe("tentative");
    expect(tentative?.["confirmed_by"]).toBeNull();
    expect(tentative?.["confirmed_at"]).toBeNull();

    // And the check is live afterwards: a confirmed row without
    // the stamps no longer goes in.
    await expect(
      raw`
        insert into events (
          school_id, id, title, kind, date_precision, starts_on, certainty,
          visibility, revision, created_by, updated_by, updated_via
        ) values (
          ${A}, 'ev-after-bad', '行事', 'event', 'day', '2026-11-10', 'confirmed',
          'guardian', 1, 'person-creator', 'person-creator', 'platform'
        )
      `,
    ).rejects.toThrow(/events_confirmation_stamps/);
  });
});
