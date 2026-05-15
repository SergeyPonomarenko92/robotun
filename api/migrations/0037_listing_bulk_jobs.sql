-- Module 5 REQ-017 / PAT-005 — async cascade job tracking.

CREATE TABLE IF NOT EXISTS listing_bulk_jobs (
  job_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type      TEXT         NOT NULL CHECK (job_type IN ('archive_provider_listings')),
  target_id     UUID         NOT NULL,
  triggered_by  TEXT         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed')),
  processed     INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_target
  ON listing_bulk_jobs (target_id, status);
CREATE INDEX IF NOT EXISTS idx_bulk_jobs_running
  ON listing_bulk_jobs (created_at) WHERE status = 'running';
