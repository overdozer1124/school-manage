CREATE TABLE "publications" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"view_definition_id" text NOT NULL,
	"target_month" text NOT NULL,
	"version_label" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text NOT NULL,
	"snapshot_note" text,
	"print_settings" jsonb NOT NULL,
	"document_format" text DEFAULT 'html' NOT NULL,
	"document_html" text NOT NULL,
	CONSTRAINT "publications_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "publications_target_month_check" CHECK ("publications"."target_month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "publications_document_format_check" CHECK ("publications"."document_format" in ('html'))
);
--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_view_fk" FOREIGN KEY ("school_id","view_definition_id") REFERENCES "public"."view_definitions"("school_id","id") ON DELETE no action ON UPDATE no action;