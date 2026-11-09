import { createDb, type Db } from "./client.js";

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
