CREATE TABLE "duty_changes" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"duty_definition_id" text NOT NULL,
	"kind" text NOT NULL,
	"assignment_a_id" text NOT NULL,
	"assignment_b_id" text,
	"from_person_id" text,
	"to_person_id" text,
	"reason" text DEFAULT '' NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "duty_changes_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "duty_changes_kind_check" CHECK ("duty_changes"."kind" in ('swap', 'substitute', 'reassign')),
	CONSTRAINT "duty_changes_status_check" CHECK ("duty_changes"."status" in ('proposed', 'applied', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "duty_conflict_waivers" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"absence_id" text NOT NULL,
	"waived_by" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duty_conflict_waivers_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "duty_conflict_waivers_pair_unique" UNIQUE("school_id","assignment_id","absence_id")
);
--> statement-breakpoint
ALTER TABLE "school_settings" ADD COLUMN "duty_conflict_absence_kinds" jsonb;--> statement-breakpoint
ALTER TABLE "duty_changes" ADD CONSTRAINT "duty_changes_definition_fk" FOREIGN KEY ("school_id","duty_definition_id") REFERENCES "public"."duty_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_conflict_waivers" ADD CONSTRAINT "duty_conflict_waivers_assignment_fk" FOREIGN KEY ("school_id","assignment_id") REFERENCES "public"."duty_assignments"("school_id","id") ON DELETE cascade ON UPDATE no action;