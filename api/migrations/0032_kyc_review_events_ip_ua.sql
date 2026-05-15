-- Module 4 REQ-014 + critic RISK-5 on SEC-010 batch.
-- spec-architecture-kyc-provider-verification.md §4.3 + REQ-014 + SEC-006:
-- "IP and user_agent SHALL be captured on every event row and SHALL NEVER
-- be returned to provider-facing endpoints."
--
-- Existing kyc_review_events rows pre-date this requirement and have no
-- captured network metadata; both columns are NULL-allowed retroactively
-- and required to be populated by application code on all new INSERTs.

ALTER TABLE kyc_review_events
  ADD COLUMN IF NOT EXISTS ip         INET,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- Index supports forensics: "all admin actions from this IP in the last 30d".
CREATE INDEX IF NOT EXISTS idx_kyc_events_ip_recent
  ON kyc_review_events (ip, created_at DESC)
  WHERE ip IS NOT NULL;
