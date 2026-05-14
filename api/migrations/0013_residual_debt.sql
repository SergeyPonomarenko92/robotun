-- Hand-written: residual debt closeout after deep-review second pass.

-- Module 9 — MANDATORY_CODES enforced at DB layer. Mirrors the TS-side
-- MANDATORY_CODES set in services/notifications.service.ts so a direct
-- DB write (admin tool, support script, migration) can't silently opt out
-- a user from legal/security notifications.
CREATE OR REPLACE FUNCTION trg_enforce_mandatory_notifications()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled = false AND NEW.channel = 'in_app' AND NEW.notification_code IN (
    'kyc_approved',
    'kyc_rejected',
    'deal_disputed_for_provider'
  ) THEN
    RAISE EXCEPTION 'cannot opt out of mandatory notification code: %', NEW.notification_code
      USING ERRCODE = 'P0009';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notif_prefs_mandatory ON notification_preferences;
--> statement-breakpoint
CREATE TRIGGER notif_prefs_mandatory
  BEFORE INSERT OR UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION trg_enforce_mandatory_notifications();
--> statement-breakpoint

-- Module 8 Feed — LATERAL aggregates were O(N×M) seq scans. Composite
-- partial indexes match the LATERAL predicates exactly so the planner
-- picks an index-only scan per provider lookup.
CREATE INDEX IF NOT EXISTS "idx_reviews_provider_aggregate"
  ON "reviews" (reviewee_id)
  WHERE status = 'published'
    AND reviewer_role = 'client'
    AND revealed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_provider_completed"
  ON "deals" (provider_id)
  WHERE status = 'completed';
--> statement-breakpoint

-- Module 12 — bypass clause for ops migrations that legitimately need to
-- patch admin_actions (typo correction, GDPR erasure backfill). Set
-- `app.admin_actions_bypass = 'on'` for the session/tx; trigger no-ops.
CREATE OR REPLACE FUNCTION trg_admin_actions_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.admin_actions_bypass', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'admin_actions is append-only (set app.admin_actions_bypass=on for ops migrations)'
    USING ERRCODE = 'P0008';
END;
$$;
