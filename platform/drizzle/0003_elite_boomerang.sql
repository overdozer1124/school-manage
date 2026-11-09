CREATE TYPE "public"."change_entity_kind" AS ENUM('day', 'event', 'absence', 'staff', 'grade', 'class', 'special_needs_class', 'day_pattern');--> statement-breakpoint
CREATE TYPE "public"."change_op" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TYPE "public"."updated_via" AS ENUM('platform', 'schedule', 'timetable');--> statement-breakpoint
CREATE TABLE "outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"school_id" text NOT NULL,
	"kind" "change_entity_kind" NOT NULL,
	"entity_id" text NOT NULL,
	"revision" integer NOT NULL,
	"op" "change_op" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_via" "updated_via" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_school_seq_index" ON "outbox" USING btree ("school_id","seq");