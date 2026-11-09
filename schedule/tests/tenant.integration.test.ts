import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { schoolCache } from "../src/db/schema.js";
import { assertOwned, tenantDb, type TenantDb } from "../src/db/tenant.js";

// Tenancy tests (DESIGN-AUTH-TENANCY 3.3): two schools of data, and
// B's tenant handle must never read, update or delete A's rows. Runs
// only when SCHEDULE_DATABASE_URL is set (see vitest.config.ts, which
// points it at the test database when one is configured).
const url = process.env.SCHEDULE_DATABASE_URL;

const A = "school-a";
const B = "school-b";

/** A stand-in business table with an id, for findById / assertOwned. */
const testItems = pgTable("tenant_test_items", {
  schoolId: text("school_id").notNull(),
  id: text("id").notNull(),
  label: text("label").notNull(),
});

describe.skipIf(!url)("schedule tenant isolation", () => {
  let queryClient: ReturnType<typeof postgres>;
  let tdbA: TenantDb;
  let tdbB: TenantDb;

  beforeAll(async () => {
    // Start from an empty schema, then apply the migrations twice:
    // the second run must be a no-op.
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.unsafe(`create table tenant_test_items (
      school_id text not null,
      id text not null,
      label text not null,
      primary key (school_id, id)
    )`);
    await admin.end();

    const created = createDb(url);
    const db: Db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    await runMigrations(db);

    tdbA = tenantDb(db, A);
    tdbB = tenantDb(db, B);
    await tdbA.insert(schoolCache, { name: "A校", slug: "school-a" });
    await tdbB.insert(schoolCache, { name: "B校", slug: "school-b" });
    await tdbA.insert(testItems, { id: "item-a1", label: "Aの項目" });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("fills school_id on insert and reads back only the own school's rows", async () => {
    const rowsA = await tdbA.select(schoolCache);
    const rowsB = await tdbB.select(schoolCache);
    expect(rowsA.map((r) => r.slug)).toEqual(["school-a"]);
    expect(rowsB.map((r) => r.slug)).toEqual(["school-b"]);
    expect(rowsA[0]?.schoolId).toBe(A);
  });

  it("cannot update or delete the other school's rows", async () => {
    const updated = await tdbB.update(
      schoolCache,
      { name: "乗っ取り" },
      eq(schoolCache.slug, "school-a"),
    );
    expect(updated).toBe(0);
    const deleted = await tdbB.delete(schoolCache, eq(schoolCache.slug, "school-a"));
    expect(deleted).toBe(0);
    const stillThere = await tdbA.select(schoolCache);
    expect(stillThere[0]?.name).toBe("A校");
  });

  it("findById and assertOwned stay inside the school", async () => {
    expect((await tdbA.findById(testItems, "item-a1"))?.label).toBe("Aの項目");
    expect(await tdbB.findById(testItems, "item-a1")).toBeUndefined();
    await expect(assertOwned(tdbA, testItems, ["item-a1"])).resolves.toBeUndefined();
    await expect(assertOwned(tdbB, testItems, ["item-a1"])).rejects.toThrow("not owned");
  });
});
