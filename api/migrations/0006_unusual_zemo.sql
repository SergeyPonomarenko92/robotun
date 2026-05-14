DO $$ BEGIN
 CREATE TYPE "public"."review_status" AS ENUM('pending', 'published', 'hidden', 'removed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."review_reviewer_role" AS ENUM('client', 'provider');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"listing_id" uuid,
	"reviewer_id" uuid,
	"reviewee_id" uuid NOT NULL,
	"reviewer_role" "review_reviewer_role" NOT NULL,
	"overall_rating" smallint NOT NULL,
	"quality_rating" smallint,
	"communication_rating" smallint,
	"timeliness_rating" smallint,
	"comment" text,
	"status" "review_status" DEFAULT 'published' NOT NULL,
	"both_submitted" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewee_id_users_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_one_reply_per_review" ON "review_replies" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_review_replies_author" ON "review_replies" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_review_deal_role" ON "reviews" USING btree ("deal_id","reviewer_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_listing_published" ON "reviews" USING btree ("listing_id","revealed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_reviewee_published" ON "reviews" USING btree ("reviewee_id","revealed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_deal" ON "reviews" USING btree ("deal_id");--> statement-breakpoint

-- Module 7 augmentation: CHECKs, partial indexes, both_submitted trigger.

ALTER TABLE "reviews"
  ADD CONSTRAINT "chk_reviewer_ne_reviewee"
  CHECK (reviewer_id IS NULL OR reviewer_id <> reviewee_id);
--> statement-breakpoint
ALTER TABLE "reviews"
  ADD CONSTRAINT "chk_comment_length" CHECK (
    comment IS NULL OR char_length(comment) BETWEEN 20 AND 2000
  );
--> statement-breakpoint
ALTER TABLE "reviews"
  ADD CONSTRAINT "chk_rating_fields" CHECK (
    overall_rating BETWEEN 1 AND 5
    AND CASE reviewer_role
      WHEN 'client' THEN
        quality_rating BETWEEN 1 AND 5
        AND communication_rating BETWEEN 1 AND 5
        AND timeliness_rating BETWEEN 1 AND 5
      WHEN 'provider' THEN
        quality_rating IS NULL
        AND communication_rating IS NULL
        AND timeliness_rating IS NULL
      ELSE false
    END
  );
--> statement-breakpoint
ALTER TABLE "reviews"
  ADD CONSTRAINT "chk_revealed_only_when_published" CHECK (
    revealed_at IS NULL OR status IN ('published','hidden','removed')
  );
--> statement-breakpoint
ALTER TABLE "review_replies"
  ADD CONSTRAINT "chk_reply_body_length" CHECK (char_length(body) BETWEEN 1 AND 2000);
--> statement-breakpoint
ALTER TABLE "review_replies"
  ADD CONSTRAINT "chk_reply_status" CHECK (status IN ('published','hidden'));
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_reviews_listing_published";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_reviews_reviewee_published";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_listing_published"
  ON "reviews" ("listing_id", "revealed_at" DESC)
  WHERE status = 'published' AND reviewer_role = 'client';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reviews_reviewee_published"
  ON "reviews" ("reviewee_id", "revealed_at" DESC)
  WHERE status = 'published';
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_reviews_updated_at ON reviews;
--> statement-breakpoint
CREATE TRIGGER set_reviews_updated_at BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_review_replies_updated_at ON review_replies;
--> statement-breakpoint
CREATE TRIGGER set_review_replies_updated_at BEFORE UPDATE ON review_replies
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
--> statement-breakpoint

-- §4.1.1 both_submitted maintenance trigger.
CREATE OR REPLACE FUNCTION trg_set_both_submitted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_client_done   BOOLEAN;
  v_provider_done BOOLEAN;
BEGIN
  SELECT
    EXISTS(SELECT 1 FROM reviews WHERE deal_id = NEW.deal_id
           AND reviewer_role = 'client' AND status = 'published'),
    EXISTS(SELECT 1 FROM reviews WHERE deal_id = NEW.deal_id
           AND reviewer_role = 'provider' AND status = 'published')
  INTO v_client_done, v_provider_done;
  UPDATE reviews
     SET both_submitted = (v_client_done AND v_provider_done)
   WHERE deal_id = NEW.deal_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_reviews_both_submitted ON reviews;
--> statement-breakpoint
CREATE TRIGGER trg_reviews_both_submitted
  AFTER INSERT OR UPDATE OF status ON reviews
  FOR EACH ROW EXECUTE FUNCTION trg_set_both_submitted();

-- §4.3 deny reply creation/edit before parent revealed.
CREATE OR REPLACE FUNCTION trg_deny_reply_before_reveal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_revealed_at TIMESTAMPTZ;
BEGIN
  SELECT revealed_at INTO v_revealed_at FROM reviews WHERE id = NEW.review_id;
  IF v_revealed_at IS NULL THEN
    RAISE EXCEPTION 'reply requires revealed review'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS deny_reply_before_reveal ON review_replies;
--> statement-breakpoint
CREATE TRIGGER deny_reply_before_reveal
  BEFORE INSERT OR UPDATE ON review_replies
  FOR EACH ROW EXECUTE FUNCTION trg_deny_reply_before_reveal();
