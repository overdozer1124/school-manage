import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Schedule's own schema. The school master itself lives in the
 * platform (the source of truth); this database holds only a display
 * cache of the school name and slug (DESIGN-AUTH-TENANCY 3.1).
 * Business tables arrive with their own issues; every one of them
 * carries school_id, with per-school uniqueness and composite foreign
 * keys, as in the platform schema.
 */
export const schoolCache = pgTable("school_cache", {
  schoolId: text("school_id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SchoolCacheRow = typeof schoolCache.$inferSelect;
