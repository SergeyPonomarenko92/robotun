-- Hand-written: fixes from deep-review pass on Modules 2/9/11/12.

-- Module 11 — expand deals.cancellation_reason CHECK to include expired_pending
-- per Module 3 spec §4.5; payments.service paymentStateFromDeal already
-- handles it as "never held".
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "chk_cancellation_reason";
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_cancellation_reason" CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'escrow_timeout','dispute_unresolved','provider_suspended',
      'escrow_hold_expired','mutual','rejected_by_provider',
      'cancelled_by_client','expired_pending'
    )
  );
--> statement-breakpoint

-- Module 11 — DB-level CHECK on resolution_outcome (defense-in-depth).
ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "chk_resolution_outcome";
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_resolution_outcome" CHECK (
    resolution_outcome IS NULL OR resolution_outcome IN (
      'release_to_provider','refund_to_client','split'
    )
  );
--> statement-breakpoint

-- Module 11 — failure_reason bloat cap.
ALTER TABLE "payouts"
  ADD CONSTRAINT "chk_failure_reason_len"
  CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 1000);
--> statement-breakpoint

-- Module 2 — replace whole-row UNIQUE with partial per-scope. NULLs in btree
-- are distinct so the original index didn't enforce uniqueness for deal-
-- scoped rows (or pre_deal rows on the deal index).
DROP INDEX IF EXISTS "uq_conv_pre_deal";
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_conv_deal";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conv_pre_deal"
  ON "conversations" ("listing_id", "client_id")
  WHERE kind = 'pre_deal' AND listing_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conv_deal"
  ON "conversations" ("deal_id")
  WHERE kind = 'deal' AND deal_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "chk_conv_scope_xor" CHECK (
    (kind = 'pre_deal' AND listing_id IS NOT NULL AND deal_id IS NULL)
    OR (kind = 'deal' AND deal_id IS NOT NULL AND listing_id IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "chk_client_ne_provider_conv" CHECK (client_id <> provider_id);
--> statement-breakpoint

-- Module 9 — per-consumer cursors (Notifications no longer mutates
-- outbox_events.status). Cursor row per consumer name; advisory lock on the
-- row gives single-active semantics.
CREATE TABLE IF NOT EXISTS "notification_consumer_cursors" (
  "consumer_name" text PRIMARY KEY,
  "last_seen_id" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO notification_consumer_cursors (consumer_name, last_seen_id)
  VALUES ('notifications:in_app', 0)
  ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Module 12 — denormalized target user UUID for audit timeline survival
-- after GDPR erasure (FK preserves linkage via target_user_id with SET NULL).
ALTER TABLE "admin_actions"
  ADD COLUMN IF NOT EXISTS "target_user_id_denorm" uuid;
--> statement-breakpoint

-- Module 12 — append-only enforcement (mirrors KYC SEC-006). We don't know
-- the application role name at this layer, but we can install an updates/
-- delete deny trigger that fires unconditionally — operators can grant a
-- specific superuser role to bypass for ops-time amendments.
CREATE OR REPLACE FUNCTION trg_admin_actions_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_actions is append-only' USING ERRCODE = 'P0008';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS admin_actions_no_update ON admin_actions;
--> statement-breakpoint
CREATE TRIGGER admin_actions_no_update
  BEFORE UPDATE OR DELETE ON admin_actions
  FOR EACH ROW EXECUTE FUNCTION trg_admin_actions_immutable();
