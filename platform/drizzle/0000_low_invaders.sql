CREATE TYPE "public"."entitlement_status" AS ENUM('active', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'approved', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."product" AS ENUM('schedule', 'timetable');--> statement-breakpoint
CREATE TYPE "public"."product_role" AS ENUM('Admin', 'Editor', 'Viewer');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text,
	"person_id" text,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"person_id" text NOT NULL,
	"status" "membership_status" DEFAULT 'invited' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"starts_on" date,
	"ends_on" date,
	"teacher_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_school_person_unique" UNIQUE("school_id","person_id"),
	CONSTRAINT "memberships_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"google_id" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persons_email_unique" UNIQUE("email"),
	CONSTRAINT "persons_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"person_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"product" "product" NOT NULL,
	"plan" text NOT NULL,
	"status" "entitlement_status" DEFAULT 'active' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_entitlements_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "product_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"product" "product" NOT NULL,
	"role" "product_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_roles_membership_product_unique" UNIQUE("membership_id","product"),
	CONSTRAINT "product_roles_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "school_years" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"year" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"term_system" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_years_school_year_unique" UNIQUE("school_id","year"),
	CONSTRAINT "school_years_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"school_id" text PRIMARY KEY NOT NULL,
	"slug" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" text PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"school_year_id" text NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_school_id_unique" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_entitlements" ADD CONSTRAINT "product_entitlements_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_roles" ADD CONSTRAINT "product_roles_membership_fk" FOREIGN KEY ("school_id","membership_id") REFERENCES "public"."memberships"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_years" ADD CONSTRAINT "school_years_school_id_schools_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("school_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_year_fk" FOREIGN KEY ("school_id","school_year_id") REFERENCES "public"."school_years"("school_id","id") ON DELETE no action ON UPDATE no action;