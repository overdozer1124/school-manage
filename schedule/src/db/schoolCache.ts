import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { schoolCache } from "./schema.js";

/**
 * The school display cache's store (DESIGN-AUTH-TENANCY 3.1):
 * this database holds no school master, only each school's name
 * and slug as the platform reported them. The slug is what the
 * public route checks a presented token against (Issue #41
 * review): a token answers only under its own school's slug, so
 * the cache is also the slug → school resolution the public
 * actions use. Rows arrive by sync (see the token actions);
 * nothing else writes here.
 */

/** The school a slug names, or null when this server has never
 *  synced that slug. Slugs are unique across schools (the
 * platform's schools table), so one row is the whole answer. */
export async function findSchoolIdBySlug(db: Db, slug: string): Promise<string | null> {
  const rows = await db
    .select({ schoolId: schoolCache.schoolId })
    .from(schoolCache)
    .where(eq(schoolCache.slug, slug));
  return rows[0]?.schoolId ?? null;
}

/** Records (or refreshes) one school's name and slug. */
export async function upsertSchoolCache(
  db: Db,
  row: { schoolId: string; name: string; slug: string },
): Promise<void> {
  await db
    .insert(schoolCache)
    .values({ ...row, syncedAt: new Date() })
    .onConflictDoUpdate({
      target: schoolCache.schoolId,
      set: { name: row.name, slug: row.slug, syncedAt: new Date() },
    });
}
