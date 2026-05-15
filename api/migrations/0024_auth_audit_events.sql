-- Hand-written: Module 1 — auth audit events.
-- Separate from admin_actions (which logs admin/moderator activity).
-- This table records user-side security-relevant events for both ops
-- forensics and user-visible "your recent activity" surface.
--
-- event_type enum: login_success, login_failure, logout, refresh,
-- password_changed, password_reset_requested, password_reset_completed,
-- email_verification_requested, email_verified, sessions_logged_out_all,
-- profile_updated, account_deleted.
--
-- ON DELETE SET NULL on user_id so audit rows survive account deletion
-- (the trail of WHO did WHAT is still useful even when the account is
-- anonymised). user_id NULL is fine for failed-login events too.

CREATE TABLE IF NOT EXISTS "auth_audit_events" (
  "id" bigserial PRIMARY KEY,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "ip" text,
  "user_agent" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_auth_audit_user"
  ON "auth_audit_events" ("user_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_auth_audit_event_type"
  ON "auth_audit_events" ("event_type", "created_at" DESC);
