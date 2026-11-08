ALTER TABLE "memberships" DROP CONSTRAINT "memberships_school_person_unique";--> statement-breakpoint
-- Issue #14: one membership row per enrolment period. The exclusion
-- constraint below (hand-written; drizzle cannot model it) refuses a
-- second row for the same school and person whose period overlaps an
-- existing one. daterange treats a NULL bound as unbounded, so an
-- open-ended membership overlaps everything after its start.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_no_overlap_period" EXCLUDE USING gist ("school_id" WITH =, "person_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);