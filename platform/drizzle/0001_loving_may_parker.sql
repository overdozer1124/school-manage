ALTER TABLE "persons" DROP CONSTRAINT "persons_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "persons_email_lower_unique" ON "persons" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_period_order" CHECK ("memberships"."starts_on" <= "memberships"."ends_on");--> statement-breakpoint
ALTER TABLE "product_entitlements" ADD CONSTRAINT "product_entitlements_period_order" CHECK ("product_entitlements"."starts_on" <= "product_entitlements"."ends_on");--> statement-breakpoint
ALTER TABLE "school_years" ADD CONSTRAINT "school_years_period_order" CHECK ("school_years"."starts_on" <= "school_years"."ends_on");--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_period_order" CHECK ("terms"."starts_on" <= "terms"."ends_on");