-- Module 5 CON-009 + PAT-004 — multi-cause auto-pause vocabulary.
-- listings.auto_paused_reasons TEXT[] with allowed-values CHECK.
-- Existing rows default to empty array. GIN index supports "any pause cause
-- including report_threshold" admin queue queries.

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS auto_paused_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE listings
  DROP CONSTRAINT IF EXISTS chk_auto_paused_reasons;
ALTER TABLE listings
  ADD CONSTRAINT chk_auto_paused_reasons CHECK (
    auto_paused_reasons <@ ARRAY[
      'report_threshold','provider_suspended','provider_kyc_revoked','category_archived'
    ]::TEXT[]
  );

CREATE INDEX IF NOT EXISTS idx_listings_auto_paused_reasons
  ON listings USING GIN (auto_paused_reasons)
  WHERE array_length(auto_paused_reasons, 1) IS NOT NULL;
