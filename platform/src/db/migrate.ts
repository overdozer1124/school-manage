import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.js";

/**
 * Applies the committed migrations in platform/drizzle. Drizzle records
 * what has run, so applying twice is a no-op the second time.
 */
export async function runMigrations(
  db: Db,
  migrationsFolder: string = new URL("../../drizzle", import.meta.url).pathname,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
