ALTER TABLE "persons" ADD COLUMN "password_scope_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "password_scope_school_id" text;