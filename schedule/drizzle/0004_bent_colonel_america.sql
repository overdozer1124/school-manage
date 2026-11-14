CREATE TABLE "duty_assignments" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"duty_definition_id" text NOT NULL,
	"date" date NOT NULL,
	"slot" text DEFAULT 'all_day' NOT NULL,
	"person_id" text,
	"target_id" text,
	"note" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"is_manual_override" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duty_assignments_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "duty_assignments_cell_unique" UNIQUE("school_id","duty_definition_id","date","slot"),
	CONSTRAINT "duty_assignments_holder_check" CHECK ("duty_assignments"."person_id" is null or "duty_assignments"."target_id" is null),
	CONSTRAINT "duty_assignments_origin_check" CHECK ("duty_assignments"."origin" in ('auto', 'manual', 'swap')),
	CONSTRAINT "duty_assignments_slot_check" CHECK ("duty_assignments"."slot" in ('all_day', 'am', 'pm', 'week') or "duty_assignments"."slot" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "duty_definitions" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"granularity" text NOT NULL,
	"applicable_period" text NOT NULL,
	"applicable_starts_on" date,
	"applicable_ends_on" date,
	"target_group_id" text,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "duty_definitions_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "duty_definitions_granularity_check" CHECK ("duty_definitions"."granularity" in ('day', 'am_pm', 'week', 'period')),
	CONSTRAINT "duty_definitions_applicable_period_check" CHECK ("duty_definitions"."applicable_period" in ('all_year', 'term', 'long_vacation_only', 'custom_range')),
	CONSTRAINT "duty_definitions_range_order" CHECK ("duty_definitions"."applicable_starts_on" is null or "duty_definitions"."applicable_ends_on" is null or "duty_definitions"."applicable_starts_on" <= "duty_definitions"."applicable_ends_on")
);
--> statement-breakpoint
CREATE TABLE "rotation_rules" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"duty_definition_id" text NOT NULL,
	"person_ids" jsonb NOT NULL,
	"change_weekdays" jsonb,
	CONSTRAINT "rotation_rules_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "rotation_rules_definition_unique" UNIQUE("school_id","duty_definition_id")
);
--> statement-breakpoint
ALTER TABLE "duty_assignments" ADD CONSTRAINT "duty_assignments_definition_fk" FOREIGN KEY ("school_id","duty_definition_id") REFERENCES "public"."duty_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_assignments" ADD CONSTRAINT "duty_assignments_target_fk" FOREIGN KEY ("school_id","target_id") REFERENCES "public"."targets"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duty_definitions" ADD CONSTRAINT "duty_definitions_group_fk" FOREIGN KEY ("school_id","target_group_id") REFERENCES "public"."target_groups"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_rules" ADD CONSTRAINT "rotation_rules_definition_fk" FOREIGN KEY ("school_id","duty_definition_id") REFERENCES "public"."duty_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_columns" ADD CONSTRAINT "view_columns_duty_fk" FOREIGN KEY ("school_id","duty_definition_id") REFERENCES "public"."duty_definitions"("school_id","id") ON DELETE no action ON UPDATE no action;