import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.js";

/**
 * Applies the committed migrations in schedule/drizzle. Drizzle
 * records what has run, so applying twice is a no-op the second time.
 * fileURLToPath is required: URL.pathname keeps a leading slash and
 * the drive letter on Windows ("/C:/..."), which is not a usable path
 * there.
 */
export async function runMigrations(
  db: Db,
  migrationsFolder: string = fileURLToPath(new URL("../../drizzle", import.meta.url)),
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
