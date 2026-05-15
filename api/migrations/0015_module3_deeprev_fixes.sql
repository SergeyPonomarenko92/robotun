-- Hand-written: deep-review fixes for Module 3 Deals MVP (efafd78).

-- 1. Scope idempotency-key uniqueness to (client_id, key). Was globally unique,
--    which let one client squat keys for unrelated clients and disclose
--    cross-tenant existence via the 403 replay path.
DROP INDEX IF EXISTS "uq_deals_idempotency_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deals_client_idempotency"
  ON "deals" USING btree ("client_id", "idempotency_key");
--> statement-breakpoint

-- 2. Spec §4.1 CON-010 — cancel_requested_* timestamps only valid while the
--    deal is in 'active' (or has terminally landed in 'cancelled' carrying the
--    final stamp from the second-party request). Defense-in-depth in case any
--    direct UPDATE or future migration bypasses the service guard.
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "chk_cancel_only_in_active";
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_cancel_only_in_active" CHECK (
    (cancel_requested_by_client_at IS NULL AND cancel_requested_by_provider_at IS NULL)
    OR status IN ('active','cancelled')
  );
--> statement-breakpoint

-- 3. Cap agreed_price at 99_999_999 kopecks (₴999,999.99) per spec REQ-014.
--    chk_deals_price already enforces > 0; add upper bound.
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "chk_deals_price_cap";
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_deals_price_cap" CHECK (agreed_price <= 99999999);
--> statement-breakpoint

-- 4. Module 7 Reviews — provider-profile rating role filter is now enforced
--    in the service (aggregatesFor("user")), but the DB has no defense if a
--    different code path queries reviews directly. Index used for the filtered
--    aggregate read to keep it cheap.
CREATE INDEX IF NOT EXISTS "idx_reviews_reviewee_role_published"
  ON "reviews" ("reviewee_id", "reviewer_role")
  WHERE status = 'published' AND revealed_at IS NOT NULL;
--> statement-breakpoint

-- 5. Module 7 Reviews — DB-level reply author enforcement. App-layer is the
--    only gate today; this trigger raises if author_id ≠ reviews.reviewee_id.
CREATE OR REPLACE FUNCTION trg_review_reply_author_eq_reviewee()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  expected_author uuid;
BEGIN
  SELECT reviewee_id INTO expected_author FROM reviews WHERE id = NEW.review_id;
  IF expected_author IS NULL THEN
    RAISE EXCEPTION 'review_not_found' USING ERRCODE = '23503';
  END IF;
  IF NEW.author_id <> expected_author THEN
    RAISE EXCEPTION 'reply_author_must_be_reviewee' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_review_reply_author_eq_reviewee ON review_replies;
--> statement-breakpoint
CREATE TRIGGER trg_review_reply_author_eq_reviewee
  BEFORE INSERT OR UPDATE OF author_id ON review_replies
  FOR EACH ROW EXECUTE FUNCTION trg_review_reply_author_eq_reviewee();
