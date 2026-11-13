CREATE TABLE "view_columns" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"view_definition_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"item_definition_id" text,
	"duty_definition_id" text,
	"target_group_id" text,
	"group_same_values" boolean DEFAULT true NOT NULL,
	"width_hint" integer,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "view_columns_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "view_columns_source_kind_check" CHECK ("view_columns"."source_kind" in ('event_category', 'daily_item', 'duty', 'day_attribute')),
	CONSTRAINT "view_columns_source_ref_check" CHECK (("view_columns"."source_kind" = 'daily_item' and "view_columns"."item_definition_id" is not null and "view_columns"."duty_definition_id" is null)
        or ("view_columns"."source_kind" = 'duty' and "view_columns"."duty_definition_id" is not null and "view_columns"."item_definition_id" is null)
        or ("view_columns"."source_kind" in ('event_category', 'day_attribute') and "view_columns"."item_definition_id" is null and "view_columns"."duty_definition_id" is null))
);
--> statement-breakpoint
CREATE TABLE "view_definitions" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"layout" text NOT NULL,
	"layout_params_json" jsonb,
	"audience" text NOT NULL,
	"period_scope" text NOT NULL,
	"print_settings" jsonb,
	CONSTRAINT "view_definitions_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "view_definitions_school_name_unique" UNIQUE("school_id","name"),
	CONSTRAINT "view_definitions_layout_check" CHECK ("view_definitions"."layout" in ('month_rows', 'week_rows', 'year_columns', 'calendar_grid', 'week_timeline', 'transposed')),
	CONSTRAINT "view_definitions_audience_check" CHECK ("view_definitions"."audience" in ('staff', 'guardian', 'student', 'public')),
	CONSTRAINT "view_definitions_period_scope_check" CHECK ("view_definitions"."period_scope" in ('week', 'two_weeks', 'month', 'year'))
);
--> statement-breakpoint
ALTER TABLE "view_columns" ADD CONSTRAINT "view_columns_view_fk" FOREIGN KEY ("school_id","view_definition_id") REFERENCES "public"."view_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_columns" ADD CONSTRAINT "view_columns_item_fk" FOREIGN KEY ("school_id","item_definition_id") REFERENCES "public"."item_definitions"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_columns" ADD CONSTRAINT "view_columns_target_group_fk" FOREIGN KEY ("school_id","target_group_id") REFERENCES "public"."target_groups"("school_id","id") ON DELETE no action ON UPDATE no action;