import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Creates a drizzle client for the platform database.
 * The connection string comes from PLATFORM_DATABASE_URL only; there is no
 * default, so a missing variable fails loudly instead of connecting
 * somewhere unexpected.
 */
export function createDb(connectionString: string | undefined = process.env.PLATFORM_DATABASE_URL) {
  if (!connectionString) {
    throw new Error("PLATFORM_DATABASE_URL is not set");
  }
  const queryClient = postgres(connectionString, { max: 1 });
  return { db: drizzle(queryClient), queryClient };
}
