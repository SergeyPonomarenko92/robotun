-- Hand-written: Module 1 — password reset tokens.
-- One-time tokens issued via /auth/forgot-password, redeemed via
-- /auth/reset-password within 30 minutes.
--
-- token_hash = sha256(plaintext); plaintext is delivered only via the
-- email link (URL query param). UNIQUE prevents collision; used_at
-- enforces single-use.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_password_reset_tokens_hash"
  ON "password_reset_tokens" ("token_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_user"
  ON "password_reset_tokens" ("user_id");
