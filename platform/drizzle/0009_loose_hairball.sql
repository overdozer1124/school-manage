ALTER TABLE "events" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Issue #85: events confirmed before this migration carry no
-- confirmation record. The only person and moment the row itself
-- records are its creator and its creation, so those stand in for
-- the stamps; without this, every already-confirmed event would
-- fail the check added below. Tentative events keep both null.
UPDATE "events" SET "confirmed_by" = "created_by", "confirmed_at" = "created_at" WHERE "certainty" = 'confirmed';--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_confirmation_stamps" CHECK (("events"."certainty" = 'tentative' and "events"."confirmed_by" is null and "events"."confirmed_at" is null)
        or ("events"."certainty" = 'confirmed' and "events"."confirmed_by" is not null and "events"."confirmed_at" is not null));