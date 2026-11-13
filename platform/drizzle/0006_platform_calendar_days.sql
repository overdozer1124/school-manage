ALTER TYPE "public"."change_entity_kind" ADD VALUE 'holiday' BEFORE 'event';--> statement-breakpoint
CREATE TABLE "day_records" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"date" date NOT NULL,
	"day_type" text NOT NULL,
	"day_type_label" text,
	"day_schedule_id" text,
	"weekday_swap" text,
	"note" text,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_records_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "day_records_school_date_unique" UNIQUE("school_id","date"),
	CONSTRAINT "day_records_day_type_check" CHECK ("day_records"."day_type" in ('class_day', 'closed_day', 'long_vacation', 'attendance_day', 'event_day')),
	CONSTRAINT "day_records_weekday_swap_check" CHECK ("day_records"."weekday_swap" is null or "day_records"."weekday_swap" in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'))
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "holidays_school_date_kind_unique" UNIQUE("school_id","date","kind"),
	CONSTRAINT "holidays_kind_check" CHECK ("holidays"."kind" in ('national_holiday', 'substitute_holiday', 'school_closed_day', 'office_closed_day'))
);
--> statement-breakpoint
ALTER TABLE "day_records" ADD CONSTRAINT "day_records_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_records" ADD CONSTRAINT "day_records_day_pattern_fk" FOREIGN KEY ("school_id","day_schedule_id") REFERENCES "public"."day_patterns"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;