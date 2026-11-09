import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Creates a drizzle client for the schedule database.
 * The connection string comes from SCHEDULE_DATABASE_URL only; there
 * is no default, so a missing variable fails loudly instead of
 * connecting somewhere unexpected. The schedule login role can
 * connect to the schedule database only (DESIGN-INTEGRATION 8-3-2).
 */
export function createDb(connectionString: string | undefined = process.env.SCHEDULE_DATABASE_URL) {
  if (!connectionString) {
    throw new Error("SCHEDULE_DATABASE_URL is not set");
  }
  const queryClient = postgres(connectionString, { max: 1 });
  return { db: drizzle(queryClient), queryClient };
}

export type Db = ReturnType<typeof createDb>["db"];
