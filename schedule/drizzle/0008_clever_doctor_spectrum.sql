CREATE TABLE "public_view_tokens" (
	"school_id" text NOT NULL,
	"id" text NOT NULL,
	"view_definition_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "public_view_tokens_school_id_id_pk" PRIMARY KEY("school_id","id"),
	CONSTRAINT "public_view_tokens_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "public_view_tokens" ADD CONSTRAINT "public_view_tokens_view_fk" FOREIGN KEY ("school_id","view_definition_id") REFERENCES "public"."view_definitions"("school_id","id") ON DELETE cascade ON UPDATE no action;