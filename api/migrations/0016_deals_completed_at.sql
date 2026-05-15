-- Hand-written: stable anchor for Module 7 60d review window + general
-- completion timestamp. Replaces the deals.updated_at heuristic — which any
-- mutation (admin flag, version bump, future moderation) resets — with a
-- write-once column set at the moment status flips to 'completed'.
--
-- Module 7 review window now reads deals.completed_at; falls back to
-- updated_at for the (small) backlog of historical completed deals.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint

-- Backfill historical rows. Best effort — no deal_events join because the
-- 'completed'-event row was not always emitted in MVP early days, and the
-- updated_at heuristic is what reviews.service was already using, so this
-- preserves existing behavior for old rows while new completions get a
-- stable anchor.
UPDATE "deals"
   SET "completed_at" = "updated_at"
 WHERE "status" = 'completed'
   AND "completed_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_deals_completed_at"
  ON "deals" ("completed_at")
  WHERE "status" = 'completed';
