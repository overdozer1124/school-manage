CREATE TABLE "classes" (
	"school_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"grade_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "day_pattern_periods" (
	"school_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"day_pattern_id" text NOT NULL,
	"period" integer NOT NULL,
	"label" text NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	CONSTRAINT "day_pattern_periods_school_id_unique" UNIQUE("school_id","id"),
	CONSTRAINT "day_pattern_periods_pattern_period_unique" UNIQUE("school_id","day_pattern_id","period")
);
--> statement-breakpoint
CREATE TABLE "day_patterns" (
	"school_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_patterns_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"school_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"stage" text,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grades_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "special_needs_classes" (
	"school_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "special_needs_classes_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "staff_members" (
	"school_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"person_id" text,
	"revision" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_via" "updated_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_members_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_grade_fk" FOREIGN KEY ("school_id","grade_id") REFERENCES "public"."grades"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_pattern_periods" ADD CONSTRAINT "day_pattern_periods_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_pattern_periods" ADD CONSTRAINT "day_pattern_periods_pattern_fk" FOREIGN KEY ("school_id","day_pattern_id") REFERENCES "public"."day_patterns"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_patterns" ADD CONSTRAINT "day_patterns_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_needs_classes" ADD CONSTRAINT "special_needs_classes_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_teacher_fk" FOREIGN KEY ("school_id","teacher_id") REFERENCES "public"."staff_members"("school_id","id") ON DELETE no action ON UPDATE no action;