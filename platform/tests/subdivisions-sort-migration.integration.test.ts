import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

// Migration test for Issue #91: a database that already holds
// subdivision definitions must pass through the migration that
// adds the sort column with every row keeping the order it had
// — lists were by kind, then key — so the backfill ranks each
// kind's rows by key. The pre-migration schema is built from a
// copy of the migration folder with the journal cut back to
// the events-confirmation migration (0009). Runs only when
// PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const DRIZZLE = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A copy of the migration folder that stops at 0009: the 0010
 *  SQL and snapshot are left out and the journal is trimmed. */
function folderBefore0010(): string {
  const dir = mkdtempSync(join(tmpdir(), "sm-drizzle-before-0010-"));
  cpSync(DRIZZLE, dir, { recursive: true });
  rmSync(join(dir, "0010_overjoyed_harpoon.sql"));
  rmSync(join(dir, "meta", "0010_snapshot.json"));
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  return dir;
}

describe.skipIf(!url)("subdivision sort migration (Issue #91)", () => {
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
    beforeDir = folderBefore0010();
    await runMigrations(db, beforeDir);

    // A school and subdivision definitions of the old shape (no
    // sort column exists yet), inserted out of key order on
    // purpose: the order a list showed was the key's, not the
    // insertion's.
    await raw`
      insert into schools (school_id, slug, name) values (${A}, 'school-a', 'A校')
    `;
    const insert = (id: string, code: string, key: string, label: string) =>
      raw`
        insert into absence_subdivisions (
          school_id, id, code, key, label, revision, updated_by, updated_via
        ) values (${A}, ${id}, ${code}, ${key}, ${label}, 1, 'person-editor', 'platform')
      `;
    await insert("subdiv-leave-sick", "leave", "sick", "病休");
    await insert("subdiv-leave-annual", "leave", "annual", "年休");
    await insert("subdiv-leave-other", "leave", "other", "その他");
    await insert("subdiv-leave-nursing", "leave", "nursing", "看護");
    await insert("subdiv-training-b", "training", "b_key", "研修B");
    await insert("subdiv-training-a", "training", "a_key", "研修A");
  });

  afterAll(async () => {
    rmSync(beforeDir, { recursive: true, force: true });
    await raw.end();
    await queryClient.end();
  });

  it("migrates existing data: every kind keeps its key order, ranked in steps of ten", async () => {
    await runMigrations(db);

    const rows = await raw`
      select code, key, sort from absence_subdivisions
      where school_id = ${A} order by code, sort, key
    `;
    expect(rows.map((r) => [r["code"], r["key"], r["sort"]])).toEqual([
      ["leave", "annual", 10],
      ["leave", "nursing", 20],
      ["leave", "other", 30],
      ["leave", "sick", 40],
      ["training", "a_key", 10],
      ["training", "b_key", 20],
    ]);
  });
});
