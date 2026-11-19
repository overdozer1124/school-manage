CREATE TABLE "webhook_deliveries" (
	"product" "product" PRIMARY KEY NOT NULL,
	"last_delivered_seq" bigint DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
