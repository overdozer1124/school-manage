import { defineConfig } from "drizzle-kit";

// The database schema itself arrives with the tenancy work (Issue #4).
// This config already fixes the dialect, the schema location and the
// migrations folder so later issues only add tables.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.PLATFORM_DATABASE_URL ?? "",
  },
});
