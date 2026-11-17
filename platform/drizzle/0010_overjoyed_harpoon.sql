ALTER TABLE "absence_subdivisions" ADD COLUMN "sort" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Issue #91: rows that predate the column keep the order they
-- always had — by kind, then by key — so the backfill ranks each
-- kind's rows by key and stamps the rank, in steps of ten like
-- the values apply-defaults writes, leaving room between rows.
UPDATE "absence_subdivisions" AS s SET "sort" = ranked.rn * 10 FROM (
	SELECT "school_id", "id", ROW_NUMBER() OVER (PARTITION BY "school_id", "code" ORDER BY "key") AS rn FROM "absence_subdivisions"
) AS ranked WHERE s."school_id" = ranked."school_id" AND s."id" = ranked."id";