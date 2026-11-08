import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./client.js";

/**
 * Tenant-scoped database access (DESIGN-AUTH-TENANCY 3.3). All reads and
 * writes of school-owned tables go through here: select / update /
 * delete always carry the school_id condition, and insert fills
 * school_id in. Application code outside src/db must not use the raw
 * client (enforced by an ESLint rule); the raw client is for migrations,
 * seeding and other platform-level work inside src/db only.
 */
export type SchoolScopedTable = PgTable & { schoolId: PgColumn; id: PgColumn };

type Row<T extends SchoolScopedTable> = T["$inferSelect"];
type InsertRow<T extends SchoolScopedTable> = Omit<T["$inferInsert"], "schoolId">;

export interface TenantDb {
  readonly schoolId: string;
  insert<T extends SchoolScopedTable>(table: T, values: InsertRow<T>): Promise<Row<T>[]>;
  select<T extends SchoolScopedTable>(table: T, where?: SQL): Promise<Row<T>[]>;
  findById<T extends SchoolScopedTable>(table: T, id: string): Promise<Row<T> | undefined>;
  update<T extends SchoolScopedTable>(table: T, set: Partial<Row<T>>, where?: SQL): Promise<number>;
  delete<T extends SchoolScopedTable>(table: T, where?: SQL): Promise<number>;
}

/**
 * The generic table typing is erased at this single point: the public
 * TenantDb interface above is fully typed, and the runtime calls are the
 * ordinary drizzle builders. (drizzle's insert() rejects a bare generic
 * table type, hence this structural view of the client.)
 */
interface LooseDb {
  insert(table: PgTable): {
    values(values: Record<string, unknown>): { returning(): Promise<unknown[]> };
  };
  select(): {
    from(table: PgTable): { where(cond: SQL | undefined): Promise<unknown[]> };
  };
  update(table: PgTable): {
    set(values: Record<string, unknown>): {
      where(cond: SQL | undefined): { returning(): Promise<unknown[]> };
    };
  };
  delete(table: PgTable): {
    where(cond: SQL | undefined): { returning(): Promise<unknown[]> };
  };
}

export function tenantDb(db: Db, schoolId: string): TenantDb {
  const loose = db as unknown as LooseDb;
  const scope = (table: SchoolScopedTable) => eq(table.schoolId, schoolId);
  const withScope = (table: SchoolScopedTable, where?: SQL) =>
    where ? and(scope(table), where) : scope(table);

  const tdb: TenantDb = {
    schoolId,

    async insert(table, values) {
      const rows = await loose
        .insert(table)
        .values({ ...values, schoolId })
        .returning();
      return rows as Row<typeof table>[];
    },

    async select(table, where) {
      const rows = await loose.select().from(table).where(withScope(table, where));
      return rows as Row<typeof table>[];
    },

    async findById(table, id) {
      const rows = await tdb.select(table, eq(table.id, id));
      return rows[0];
    },

    async update(table, set, where) {
      const safeSet = { ...set } as Record<string, unknown>;
      delete safeSet.schoolId;
      const rows = await loose
        .update(table)
        .set(safeSet)
        .where(withScope(table, where))
        .returning();
      return rows.length;
    },

    async delete(table, where) {
      const rows = await loose.delete(table).where(withScope(table, where)).returning();
      return rows.length;
    },
  };
  return tdb;
}

/**
 * Checks that every referenced id belongs to this tenant's school
 * (DESIGN-AUTH-TENANCY 3.3). Throws listing the offending ids; the
 * composite foreign keys in the schema are the second line of defence.
 */
export async function assertOwned<T extends SchoolScopedTable>(
  tdb: TenantDb,
  table: T,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tdb.select(table, inArray(table.id, [...ids]));
  const owned = new Set(rows.map((r) => (r as { id: string }).id));
  const missing = ids.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    throw new Error(`assertOwned: ids not owned by school ${tdb.schoolId}: ${missing.join(", ")}`);
  }
}
