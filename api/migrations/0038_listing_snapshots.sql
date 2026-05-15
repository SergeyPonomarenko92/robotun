-- Module 5 REQ-010 / §4 — listing_snapshots.
-- Same-tx copy at deal creation. Acts as dispute-resolution artifact:
-- the listing may be edited / archived after the deal exists, but the
-- snapshot preserves the title/description/pricing the client saw.

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID         REFERENCES listings(id) ON DELETE SET NULL,
  deal_id           UUID         NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  snapshot_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  title             VARCHAR(200) NOT NULL,
  description       TEXT         NOT NULL,
  pricing_type      TEXT         NOT NULL,
  price_amount      BIGINT,
  price_amount_max  BIGINT,
  currency          CHAR(3),
  service_type      TEXT         NOT NULL,
  category_id       UUID,
  provider_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
  purged_pii_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_snapshots_deal
  ON listing_snapshots (deal_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_listing
  ON listing_snapshots (listing_id) WHERE listing_id IS NOT NULL;
