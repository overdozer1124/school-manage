ALTER TYPE "public"."change_entity_kind" ADD VALUE 'absence_subdivision' BEFORE 'staff';--> statement-breakpoint
CREATE TABLE "absence_subdivisions" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"code" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absence_subdivisions_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "absence_subdivisions_school_code_key_unique" UNIQUE("school_id","code","key"),
	CONSTRAINT "absence_subdivisions_code_check" CHECK ("absence_subdivisions"."code" in ('business_trip', 'training', 'leave', 'other'))
);
--> statement-breakpoint
CREATE TABLE "absences" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"staff_id" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"time" jsonb NOT NULL,
	"kind" text NOT NULL,
	"subdivision_key" text,
	"purpose" text,
	"note" text,
	"certainty" text NOT NULL,
	"created_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absences_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "absences_kind_check" CHECK ("absences"."kind" in ('business_trip', 'training', 'leave', 'other')),
	CONSTRAINT "absences_certainty_check" CHECK ("absences"."certainty" in ('tentative', 'confirmed')),
	CONSTRAINT "absences_period_order" CHECK ("absences"."to_date" >= "absences"."from_date"),
	CONSTRAINT "absences_confirmation_stamps" CHECK (("absences"."certainty" = 'tentative' and "absences"."confirmed_by" is null and "absences"."confirmed_at" is null)
        or ("absences"."certainty" = 'confirmed' and "absences"."confirmed_by" is not null and "absences"."confirmed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "absence_subdivisions" ADD CONSTRAINT "absence_subdivisions_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_staff_fk" FOREIGN KEY ("school_id","staff_id") REFERENCES "public"."staff_members"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_subdivision_fk" FOREIGN KEY ("school_id","kind","subdivision_key") REFERENCES "public"."absence_subdivisions"("school_id","code","key") ON DELETE no action ON UPDATE no action;