ALTER TABLE "publications" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "snapshot_json" jsonb;