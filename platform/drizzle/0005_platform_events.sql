CREATE TABLE "event_assignees" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"event_id" text NOT NULL,
	"position" integer NOT NULL,
	"staff_id" text,
	"free_text_name" text,
	"role" text,
	CONSTRAINT "event_assignees_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "event_assignees_event_position_unique" UNIQUE("school_id","event_id","position"),
	CONSTRAINT "event_assignees_one_name_check" CHECK (("event_assignees"."staff_id" is null) <> ("event_assignees"."free_text_name" is null))
);
--> statement-breakpoint
CREATE TABLE "event_impacts" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"event_id" text NOT NULL,
	"position" integer NOT NULL,
	"impact" jsonb NOT NULL,
	CONSTRAINT "event_impacts_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "event_impacts_event_position_unique" UNIQUE("school_id","event_id","position")
);
--> statement-breakpoint
CREATE TABLE "event_targets" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"event_id" text NOT NULL,
	"position" integer NOT NULL,
	"target" jsonb NOT NULL,
	CONSTRAINT "event_targets_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "event_targets_event_position_unique" UNIQUE("school_id","event_id","position")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"kind_label" text,
	"date_precision" text NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"time" jsonb,
	"location_id" text,
	"location_text" text,
	"description" text,
	"certainty" text NOT NULL,
	"visibility" text NOT NULL,
	"revision" integer NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "events_kind_check" CHECK ("events"."kind" in ('event', 'meeting', 'exam', 'deadline', 'other')),
	CONSTRAINT "events_date_precision_check" CHECK ("events"."date_precision" in ('day', 'range', 'month', 'undecided')),
	CONSTRAINT "events_certainty_check" CHECK ("events"."certainty" in ('tentative', 'confirmed')),
	CONSTRAINT "events_visibility_check" CHECK ("events"."visibility" in ('staff_only', 'guardian', 'student', 'public')),
	CONSTRAINT "events_period_order" CHECK ("events"."ends_on" is null or "events"."starts_on" is null or "events"."ends_on" >= "events"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "event_assignees" ADD CONSTRAINT "event_assignees_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_assignees" ADD CONSTRAINT "event_assignees_event_fk" FOREIGN KEY ("school_id","event_id") REFERENCES "public"."events"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_assignees" ADD CONSTRAINT "event_assignees_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_members"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_impacts" ADD CONSTRAINT "event_impacts_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_impacts" ADD CONSTRAINT "event_impacts_event_fk" FOREIGN KEY ("school_id","event_id") REFERENCES "public"."events"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_targets" ADD CONSTRAINT "event_targets_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_targets" ADD CONSTRAINT "event_targets_event_fk" FOREIGN KEY ("school_id","event_id") REFERENCES "public"."events"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;