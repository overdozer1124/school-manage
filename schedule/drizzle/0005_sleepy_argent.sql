CREATE TABLE "event_values" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"item_definition_id" text NOT NULL,
	"target_id" text,
	"target_ref" jsonb,
	"target_key" text DEFAULT '' NOT NULL,
	"value_text" text,
	"value_time" text,
	"value_time_end" text,
	"value_number" double precision,
	"value_boolean" boolean,
	"value_option_id" text,
	"value_person_id" text,
	"value_json" jsonb,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_values_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "event_values_subject_item_unique" UNIQUE("school_id","subject_kind","subject_id","item_definition_id","target_key"),
	CONSTRAINT "event_values_subject_kind_check" CHECK ("event_values"."subject_kind" in ('event', 'absence')),
	CONSTRAINT "event_values_target_check" CHECK ("event_values"."target_id" is null or "event_values"."target_ref" is null)
);
--> statement-breakpoint
CREATE TABLE "kind_templates" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"subject_kind" text NOT NULL,
	"kind_code" text NOT NULL,
	"person_label" text NOT NULL,
	"display_source" text NOT NULL,
	"steps" jsonb NOT NULL,
	"item_definition_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "kind_templates_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "kind_templates_school_key_unique" UNIQUE("school_id","key"),
	CONSTRAINT "kind_templates_subject_kind_check" CHECK ("kind_templates"."subject_kind" in ('event', 'absence')),
	CONSTRAINT "kind_templates_kind_code_check" CHECK (("kind_templates"."subject_kind" = 'event' and "kind_templates"."kind_code" in ('event', 'meeting', 'exam', 'deadline', 'other'))
        or ("kind_templates"."subject_kind" = 'absence' and "kind_templates"."kind_code" in ('business_trip', 'training', 'leave', 'other'))),
	CONSTRAINT "kind_templates_display_source_check" CHECK ("kind_templates"."display_source" in ('title', 'person', 'person_title'))
);
--> statement-breakpoint
ALTER TABLE "event_values" ADD CONSTRAINT "event_values_item_fk" FOREIGN KEY ("school_id","item_definition_id") REFERENCES "public"."item_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_values" ADD CONSTRAINT "event_values_target_fk" FOREIGN KEY ("school_id","target_id") REFERENCES "public"."targets"("school_id","id") ON DELETE no action ON UPDATE no action;