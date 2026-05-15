-- Hand-written: Module 1 REQ-010 / AC-009 / CON-002 — soft-delete with
-- 90-day restore window followed by permanent purge.
--
-- users.deleted_at: ISO timestamp of the soft-delete event. NULL for
-- non-deleted users. The status='deleted' enum value remains the gate
-- for authentication; deleted_at is the timer for the restore window.
--
-- deleted_user_index: maps the ORIGINAL email (as a salted SHA-256
-- hash, never plaintext) back to the user_id for the restore window.
-- Allows a user to claim back their email within 90 days even after
-- it has been rewritten on the users row to deleted-{uuid}@tombstone.local.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_users_deleted_at"
  ON "users" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deleted_user_index" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "email_hash" text NOT NULL,
  "purge_after" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_deleted_user_index_email_hash"
  ON "deleted_user_index" ("email_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_deleted_user_index_purge_after"
  ON "deleted_user_index" ("purge_after");
