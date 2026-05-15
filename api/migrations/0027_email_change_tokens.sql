-- Hand-written: Module 1 — email change tokens.
-- Distinct from email_verification_tokens (which proves ownership of the
-- email at register time) — this one carries the proposed new email
-- AND the proof that the user already authenticated with their current
-- password. Single-use, hashed, 1h TTL.

CREATE TABLE IF NOT EXISTS "email_change_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "new_email" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_email_change_tokens_hash"
  ON "email_change_tokens" ("token_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_email_change_tokens_user"
  ON "email_change_tokens" ("user_id");
