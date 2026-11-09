CREATE TABLE "school_cache" (
	"school_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
