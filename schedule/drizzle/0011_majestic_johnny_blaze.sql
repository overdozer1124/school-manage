CREATE TABLE "view_month_notes" (
	"school_id" text NOT NULL,
	"view_definition_id" text NOT NULL,
	"month" text NOT NULL,
	"life_goal" text,
	"health_goal" text,
	CONSTRAINT "view_month_notes_school_id_view_definition_id_month_pk" PRIMARY KEY("school_id","view_definition_id","month"),
	CONSTRAINT "view_month_notes_month_check" CHECK ("view_month_notes"."month" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "view_definitions" DROP CONSTRAINT "view_definitions_layout_check";--> statement-breakpoint
ALTER TABLE "view_month_notes" ADD CONSTRAINT "view_month_notes_view_fk" FOREIGN KEY ("school_id","view_definition_id") REFERENCES "public"."view_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_definitions" ADD CONSTRAINT "view_definitions_layout_check" CHECK ("view_definitions"."layout" in ('month_rows', 'week_rows', 'year_columns', 'calendar_grid', 'week_timeline', 'transposed', 'two_column'));