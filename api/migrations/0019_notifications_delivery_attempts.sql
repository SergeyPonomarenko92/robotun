-- Hand-written: Module 9 — track delivery attempts on notifications so
-- drainEmailQueue can retry transient SMTP failures instead of collapsing
-- them to 'failed' on the first hiccup.
--
-- next_retry_at: backoff schedule. NULL means "retry as soon as worker
-- picks it up". Set to now()+backoff(attempts) on each failed attempt.

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "delivery_attempts" smallint NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
--> statement-breakpoint

-- Index lets drainEmailQueue scan only ready-to-send rows efficiently.
CREATE INDEX IF NOT EXISTS "idx_notifications_email_pending_ready"
  ON "notifications" ("created_at")
  WHERE channel = 'email' AND status = 'pending';
