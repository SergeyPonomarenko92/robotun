DO $$ BEGIN
 CREATE TYPE "public"."listing_pricing_type" AS ENUM('fixed', 'hourly', 'range', 'starting_from', 'discuss');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."listing_service_type" AS ENUM('on_site', 'remote', 'both');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."listing_status" AS ENUM('draft', 'in_review', 'active', 'paused', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listing_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"pricing_type" "listing_pricing_type" NOT NULL,
	"price_amount" integer,
	"price_amount_max" integer,
	"currency" text,
	"service_type" "listing_service_type" DEFAULT 'both' NOT NULL,
	"city" text,
	"region" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"cover_url" text,
	"gallery_urls" text[] DEFAULT '{}' NOT NULL,
	"response_sla_minutes" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_listing_caps" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"active_count" integer DEFAULT 0 NOT NULL,
	"draft_count" integer DEFAULT 0 NOT NULL,
	"created_today" integer DEFAULT 0 NOT NULL,
	"today_date" date DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listings" ADD CONSTRAINT "listings_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_listing_caps" ADD CONSTRAINT "provider_listing_caps_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listing_drafts_owner" ON "listing_drafts" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listings_active_cursor" ON "listings" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listings_provider_status" ON "listings" USING btree ("provider_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listings_category_active" ON "listings" USING btree ("category_id","status","published_at");--> statement-breakpoint

-- Module 5 hand-written augmentation: CHECKs, triggers, partial indexes.

ALTER TABLE "listings"
  ADD CONSTRAINT "listings_title_chk" CHECK (char_length(title) BETWEEN 5 AND 120);
--> statement-breakpoint
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_description_chk" CHECK (char_length(description) BETWEEN 20 AND 5000);
--> statement-breakpoint
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_price_amount_chk" CHECK (price_amount IS NULL OR price_amount > 0);
--> statement-breakpoint
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_price_amount_max_chk" CHECK (
    price_amount_max IS NULL OR (price_amount IS NOT NULL AND price_amount_max > price_amount)
  );
--> statement-breakpoint
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_provider_id_archived_chk"
  CHECK (provider_id IS NOT NULL OR status = 'archived');
--> statement-breakpoint
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_currency_consistent_chk" CHECK (
    (pricing_type = 'discuss' AND currency IS NULL)
    OR (pricing_type <> 'discuss' AND currency = 'UAH')
  );
--> statement-breakpoint
ALTER TABLE "listings"
  ADD CONSTRAINT "listings_price_required_chk" CHECK (
    (pricing_type IN ('fixed','hourly','starting_from') AND price_amount IS NOT NULL)
    OR (pricing_type = 'range' AND price_amount IS NOT NULL AND price_amount_max IS NOT NULL)
    OR (pricing_type = 'discuss')
  );
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_listings_active_cursor";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_listings_category_active";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listings_active_cursor"
  ON "listings" ("published_at" DESC, "id" DESC) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listings_category_active"
  ON "listings" ("category_id", "status", "published_at" DESC) WHERE status = 'active';
--> statement-breakpoint

-- §4.1 category-active check (CROSS-001 contract with Module 10).
CREATE OR REPLACE FUNCTION trg_listing_category_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('draft','in_review','active','paused')
     AND NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND status='active') THEN
    RAISE EXCEPTION 'category_not_active' USING ERRCODE = 'P0004';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS listing_category_active_check ON listings;
--> statement-breakpoint
CREATE TRIGGER listing_category_active_check
  BEFORE INSERT OR UPDATE OF category_id, status ON listings
  FOR EACH ROW EXECUTE FUNCTION trg_listing_category_active();
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_listing_updated_at ON listings;
--> statement-breakpoint
CREATE TRIGGER set_listing_updated_at
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_deny_listing_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'listing_delete_forbidden' USING ERRCODE = 'P0007';
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS deny_listing_delete ON listings;
--> statement-breakpoint
CREATE TRIGGER deny_listing_delete BEFORE DELETE ON listings
  FOR EACH ROW EXECUTE FUNCTION trg_deny_listing_delete();
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_listing_drafts_updated_at ON listing_drafts;
--> statement-breakpoint
CREATE TRIGGER set_listing_drafts_updated_at
  BEFORE UPDATE ON listing_drafts
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
