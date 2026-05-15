-- Module 5 REQ-007 §4 — listing_appeals. One open appeal per listing.

CREATE TABLE IF NOT EXISTS listing_appeals (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   UUID         NOT NULL REFERENCES listings(id),
  provider_id  UUID         NOT NULL REFERENCES users(id),
  filed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID         REFERENCES users(id),
  resolution   TEXT         CHECK (resolution IN ('reinstated','upheld')),
  admin_note   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_appeals_open
  ON listing_appeals (listing_id) WHERE resolved_at IS NULL;
