CREATE TABLE "item_definitions" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"value_type" text NOT NULL,
	"target_group_id" text,
	"target_platform_axis" text,
	"granularity" text NOT NULL,
	"default_visibility" text NOT NULL,
	"is_aggregatable" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "item_definitions_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "item_definitions_school_id_key_unique" UNIQUE("school_id","key"),
	CONSTRAINT "item_definitions_value_type_check" CHECK ("item_definitions"."value_type" in ('text', 'event_list', 'time', 'time_range', 'symbol', 'code', 'person', 'persons', 'number', 'boolean', 'target_time_map')),
	CONSTRAINT "item_definitions_platform_axis_check" CHECK ("item_definitions"."target_platform_axis" is null or "item_definitions"."target_platform_axis" in ('grade', 'class', 'special_needs_class')),
	CONSTRAINT "item_definitions_axis_check" CHECK ("item_definitions"."target_group_id" is null or "item_definitions"."target_platform_axis" is null),
	CONSTRAINT "item_definitions_granularity_check" CHECK ("item_definitions"."granularity" in ('day', 'am_pm', 'period', 'week', 'month')),
	CONSTRAINT "item_definitions_visibility_check" CHECK ("item_definitions"."default_visibility" in ('staff_only', 'guardian', 'student', 'public'))
);
--> statement-breakpoint
CREATE TABLE "item_options" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"item_definition_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"meaning" text,
	"color_hint" text,
	"counts_as" jsonb,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "item_options_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "item_options_school_id_item_definition_id_code_unique" UNIQUE("school_id","item_definition_id","code")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "locations_school_id_id_pk" PRIMARY KEY("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "school_settings" (
	"school_id" text PRIMARY KEY NOT NULL,
	"preset_key" text,
	"preset_applied_at" timestamp with time zone,
	"input_opener" text DEFAULT 'popover' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_settings_input_opener_check" CHECK ("school_settings"."input_opener" in ('popover', 'modal'))
);
--> statement-breakpoint
CREATE TABLE "target_groups" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "target_groups_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "target_groups_school_id_key_unique" UNIQUE("school_id","key")
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"target_group_id" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"parent_target_id" text,
	CONSTRAINT "targets_school_id_id_pk" PRIMARY KEY("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "item_definitions" ADD CONSTRAINT "item_definitions_group_fk" FOREIGN KEY ("school_id","target_group_id") REFERENCES "public"."target_groups"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_options" ADD CONSTRAINT "item_options_definition_fk" FOREIGN KEY ("school_id","item_definition_id") REFERENCES "public"."item_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_group_fk" FOREIGN KEY ("school_id","target_group_id") REFERENCES "public"."target_groups"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_parent_fk" FOREIGN KEY ("school_id","parent_target_id") REFERENCES "public"."targets"("school_id","id") ON DELETE no action ON UPDATE no action;