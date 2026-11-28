import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";

/**
 * Composition helper for the process entry point: builds the database
 * handle from the environment connection string. It lives in src/db
 * so the raw client stays behind the tenancy guard (see
 * eslint.config.mjs); the entry point itself never imports the client
 * module.
 */
export function createDbFromEnv(): Db {
  const { db } = createDb();
  return db;
}

/**
 * Production startup (Issue #132): applies pending migrations on the
 * schedule database, then closes the connection again. The entry
 * point calls this before it starts listening when
 * NODE_ENV=production, so a deployed process never serves against an
 * unmigrated schema. The migrations folder is passed in by the entry
 * point: its location relative to the entry file is the same in the
 * src/ layout and in the bundled dist/ layout, while this module's
 * own location differs between the two.
 */
export async function runMigrationsFromEnv(migrationsFolder: string): Promise<void> {
  const { db, queryClient } = createDb();
  try {
    await runMigrations(db, migrationsFolder);
  } finally {
    await queryClient.end();
  }
}
