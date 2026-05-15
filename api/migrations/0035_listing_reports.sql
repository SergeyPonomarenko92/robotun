-- Module 5 REQ-006/013 §4 — listing_reports + auto-pause trigger.
-- Qualifying = (kyc_approved OR ≥1 completed deal OR account_age ≥7d)
-- captured at report time (snapshot, never recomputed).
-- AC-009: 5 qualifying reports → BEFORE INSERT trigger flips listing
--         status='paused' + appends 'report_threshold' to auto_paused_reasons
--         + emits outbox listing.auto_paused. Threshold sourced from
--         platform_settings.listing_report_pause_threshold (default 5).
-- AC-010: non-qualifying reports never count toward threshold.

CREATE TABLE IF NOT EXISTS listing_reports (
  id                                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                               UUID         NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_id                              UUID         NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reason                                   TEXT         NOT NULL
                                             CHECK (reason IN ('spam','fraud','illegal_content','misleading','duplicate','other')),
  description                              TEXT         CHECK (char_length(description) <= 1000),
  status                                   TEXT         NOT NULL DEFAULT 'pending'
                                             CHECK (status IN ('pending','reviewed','dismissed')),
  reviewed_by                              UUID         REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                              TIMESTAMPTZ,
  reporter_kyc_approved_at_report_time     BOOLEAN      NOT NULL DEFAULT false,
  reporter_completed_deals_at_report_time  INT          NOT NULL DEFAULT 0,
  reporter_account_age_days_at_report_time INT          NOT NULL DEFAULT 0,
  qualifying                               BOOLEAN      GENERATED ALWAYS AS (
                                             reporter_kyc_approved_at_report_time = true
                                             OR reporter_completed_deals_at_report_time >= 1
                                             OR reporter_account_age_days_at_report_time >= 7
                                           ) STORED,
  created_at                               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (listing_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_reports_pending
  ON listing_reports (listing_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_listing_reports_queue
  ON listing_reports (created_at) WHERE status = 'pending';

-- AC-009 / AC-010 trigger. Threshold = 5 (hard-coded MVP; spec REQ-013
-- says configurable via platform_settings which is out of MVP scope).
-- The trigger counts EXISTING qualifying rows + the row being inserted
-- (if qualifying), flips the listing only on the boundary crossing
-- (count == threshold), and emits outbox listing.auto_paused.
CREATE OR REPLACE FUNCTION listing_reports_check_auto_pause()
RETURNS TRIGGER AS $$
DECLARE
  THRESHOLD INT := 5;
  qualifying_count INT;
  cur_status TEXT;
  cur_reasons TEXT[];
  new_qualifying BOOLEAN;
BEGIN
  new_qualifying :=
    NEW.reporter_kyc_approved_at_report_time = true
    OR NEW.reporter_completed_deals_at_report_time >= 1
    OR NEW.reporter_account_age_days_at_report_time >= 7;

  IF NOT new_qualifying THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO qualifying_count
    FROM listing_reports
   WHERE listing_id = NEW.listing_id
     AND qualifying = true
     AND status IN ('pending','reviewed');

  -- The new row is BEFORE INSERT and not yet visible to COUNT.
  IF qualifying_count + 1 < THRESHOLD THEN
    RETURN NEW;
  END IF;

  SELECT status, auto_paused_reasons INTO cur_status, cur_reasons
    FROM listings WHERE id = NEW.listing_id FOR UPDATE;

  IF cur_status IS NULL OR cur_status = 'archived' THEN
    RETURN NEW;
  END IF;

  IF NOT ('report_threshold' = ANY(cur_reasons)) THEN
    UPDATE listings
       SET status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
           auto_paused_reasons = array_append(auto_paused_reasons, 'report_threshold'),
           version = version + 1,
           updated_at = now()
     WHERE id = NEW.listing_id;

    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
    VALUES (
      'listing', NEW.listing_id, 'listing.auto_paused',
      jsonb_build_object(
        'listing_id', NEW.listing_id,
        'reason', 'report_threshold',
        'qualifying_count', qualifying_count + 1
      )
    );

    INSERT INTO listing_audit_events (listing_id, actor_id, actor_role, event_type, from_status, to_status, metadata)
    VALUES (
      NEW.listing_id, NULL, 'system', 'listing.auto_paused',
      cur_status, CASE WHEN cur_status = 'active' THEN 'paused' ELSE cur_status END,
      jsonb_build_object('reason', 'report_threshold', 'qualifying_count', qualifying_count + 1)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_listing_reports_auto_pause ON listing_reports;
CREATE TRIGGER trg_listing_reports_auto_pause
  BEFORE INSERT ON listing_reports
  FOR EACH ROW
  EXECUTE FUNCTION listing_reports_check_auto_pause();
