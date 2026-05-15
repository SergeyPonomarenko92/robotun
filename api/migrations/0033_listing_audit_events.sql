-- Module 5 §4 — listing_audit_events (monthly-partitioned, append-only).
-- REQ-014: draft auto-archive sweep keys on provider-initiated events here.
-- CON-011: monthly partitioning, 24-month retention.
-- SEC-005: GRANTs restricted to INSERT/SELECT in a separate migration once
--          a dedicated app role exists. MVP keeps DB owner; documented gap.

CREATE TABLE IF NOT EXISTS listing_audit_events (
  id           BIGSERIAL,
  listing_id   UUID         NOT NULL,
  actor_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  actor_role   TEXT         NOT NULL CHECK (actor_role IN ('provider','client','admin','moderator','system')),
  event_type   TEXT         NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_lae_listing_id_created
  ON listing_audit_events (listing_id, created_at DESC);

-- Bootstrap partitions for the current and next month. Long-term partition
-- maintenance lives in a separate maintenance script (out of MVP scope; the
-- partitioning skeleton + 2 forward partitions are enough to run smokes
-- across a month-boundary).
DO $$
DECLARE
  cur_month_start  DATE := date_trunc('month', now())::date;
  next_month_start DATE := (date_trunc('month', now()) + interval '1 month')::date;
  month_after_next DATE := (date_trunc('month', now()) + interval '2 month')::date;
  this_part TEXT  := 'listing_audit_events_y' || to_char(cur_month_start, 'YYYYmm');
  next_part TEXT  := 'listing_audit_events_y' || to_char(next_month_start, 'YYYYmm');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF listing_audit_events FOR VALUES FROM (%L) TO (%L)',
    this_part, cur_month_start, next_month_start
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF listing_audit_events FOR VALUES FROM (%L) TO (%L)',
    next_part, next_month_start, month_after_next
  );
END $$;
