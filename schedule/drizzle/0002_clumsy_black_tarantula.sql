CREATE TABLE "daily_values" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"date" date NOT NULL,
	"item_definition_id" text NOT NULL,
	"target_id" text,
	"target_ref" jsonb,
	"target_key" text DEFAULT '' NOT NULL,
	"slot" text DEFAULT 'all_day' NOT NULL,
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
	CONSTRAINT "daily_values_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "daily_values_cell_unique" UNIQUE("school_id","date","item_definition_id","target_key","slot"),
	CONSTRAINT "daily_values_target_check" CHECK ("daily_values"."target_id" is null or "daily_values"."target_ref" is null),
	CONSTRAINT "daily_values_slot_check" CHECK ("daily_values"."slot" in ('all_day', 'am', 'pm') or "daily_values"."slot" ~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "daily_values" ADD CONSTRAINT "daily_values_item_fk" FOREIGN KEY ("school_id","item_definition_id") REFERENCES "public"."item_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_values" ADD CONSTRAINT "daily_values_target_fk" FOREIGN KEY ("school_id","target_id") REFERENCES "public"."targets"("school_id","id") ON DELETE no action ON UPDATE no action;