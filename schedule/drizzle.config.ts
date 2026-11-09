import { defineConfig } from "drizzle-kit";

// Mirrors platform/drizzle.config.ts: the dialect, the schema location
// and the migrations folder are fixed here so later issues only add
// tables.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.SCHEDULE_DATABASE_URL ?? "",
  },
});
