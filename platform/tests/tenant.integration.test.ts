import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  memberships,
  persons,
  productEntitlements,
  productRoles,
  schoolYears,
  schools,
} from "../src/db/schema.js";
import { assertOwned, tenantDb, type TenantDb } from "../src/db/tenant.js";

// Tenancy tests (DESIGN-AUTH-TENANCY 3.3): two schools of data, and B's
// tenant handle must never read, update or delete A's rows. Runs only
// when PLATFORM_DATABASE_URL is set (see vitest.config.ts for .env).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";

describe.skipIf(!url)("tenant isolation", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let tdbA: TenantDb;
  let tdbB: TenantDb;

  beforeAll(async () => {
    // Start from an empty schema, then apply the migrations twice: the
    // second run must be a no-op (completion condition of Issue #4).
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.end();

    const created = createDb(url);
    db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    await runMigrations(db);

    await db.insert(schools).values([
      { schoolId: A, slug: "school-a", name: "A校" },
      { schoolId: B, slug: "school-b", name: "B校" },
    ]);
    await db.insert(persons).values({
      id: "person-1",
      email: "person1@example.jp",
      displayName: "教員1",
    });
    tdbA = tenantDb(db, A);
    tdbB = tenantDb(db, B);
    // One person, memberships at both schools.
    await tdbA.insert(memberships, {
      id: "membership-a1",
      personId: "person-1",
      status: "approved",
    });
    await tdbB.insert(memberships, {
      id: "membership-b1",
      personId: "person-1",
      status: "approved",
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("fills school_id on insert and reads back only the own school's rows", async () => {
    const rowsA = await tdbA.select(memberships);
    const rowsB = await tdbB.select(memberships);
    expect(rowsA.map((r) => r.id)).toEqual(["membership-a1"]);
    expect(rowsB.map((r) => r.id)).toEqual(["membership-b1"]);
    expect(rowsA[0]?.schoolId).toBe(A);
  });

  it("cannot read the other school's row by id", async () => {
    expect(await tdbB.findById(memberships, "membership-a1")).toBeUndefined();
    expect((await tdbA.findById(memberships, "membership-a1"))?.id).toBe("membership-a1");
  });

  it("cannot update or delete the other school's rows", async () => {
    const updated = await tdbB.update(
      memberships,
      { status: "suspended" },
      eq(memberships.id, "membership-a1"),
    );
    expect(updated).toBe(0);
    const deleted = await tdbB.delete(memberships, eq(memberships.id, "membership-a1"));
    expect(deleted).toBe(0);
    const stillThere = await tdbA.findById(memberships, "membership-a1");
    expect(stillThere?.status).toBe("approved");
  });

  it("assertOwned passes for own ids and throws for the other school's", async () => {
    await expect(assertOwned(tdbA, memberships, ["membership-a1"])).resolves.toBeUndefined();
    await expect(assertOwned(tdbB, memberships, ["membership-a1"])).rejects.toThrow("not owned");
  });

  it("the database refuses a cross-school foreign key", async () => {
    // B's school_id with A's membership id: the composite foreign key
    // (school_id, membership_id) -> memberships (school_id, id) rejects it.
    await expect(
      db.insert(productRoles).values({
        id: "role-cross",
        schoolId: B,
        membershipId: "membership-a1",
        product: "schedule",
        role: "Viewer",
      }),
    ).rejects.toThrow();
  });

  it("holds different roles per product on the same membership", async () => {
    await tdbA.insert(productRoles, {
      id: "role-a-timetable",
      membershipId: "membership-a1",
      product: "timetable",
      role: "Editor",
    });
    await tdbA.insert(productRoles, {
      id: "role-a-schedule",
      membershipId: "membership-a1",
      product: "schedule",
      role: "Viewer",
    });
    const roles = await tdbA.select(productRoles);
    const byProduct = Object.fromEntries(roles.map((r) => [r.product, r.role]));
    expect(byProduct).toEqual({ timetable: "Editor", schedule: "Viewer" });
    expect(await tdbB.select(productRoles)).toEqual([]);
  });

  it("closing one membership by its end date leaves the other school's membership valid", async () => {
    const closed = await tdbB.update(
      memberships,
      { endsOn: "2027-03-31" },
      eq(memberships.id, "membership-b1"),
    );
    expect(closed).toBe(1);
    const bRow = await tdbB.findById(memberships, "membership-b1");
    expect(bRow?.endsOn).toBe("2027-03-31");
    const aRow = await tdbA.findById(memberships, "membership-a1");
    expect(aRow?.status).toBe("approved");
    expect(aRow?.endsOn).toBeNull();
  });

  it("scopes school years and entitlements per school as well", async () => {
    await tdbA.insert(schoolYears, {
      id: "year-a-2026",
      year: 2026,
      startsOn: "2026-04-01",
      endsOn: "2027-03-31",
      termSystem: "trimester",
      isCurrent: true,
    });
    await tdbA.insert(productEntitlements, {
      id: "ent-a-schedule",
      product: "schedule",
      plan: "standard",
      status: "active",
      startsOn: "2026-04-01",
    });
    expect((await tdbA.select(schoolYears)).map((r) => r.id)).toEqual(["year-a-2026"]);
    expect(await tdbB.select(schoolYears)).toEqual([]);
    expect(await tdbB.select(productEntitlements)).toEqual([]);
  });
});
