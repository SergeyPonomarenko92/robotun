-- Hand-written: Module 1 — email verification tokens.
-- Same shape as password_reset_tokens (one-time, hashed, expiry).
-- Issued on register + on explicit /auth/request-email-verification.
-- Successful redemption sets users.email_verified=true AND stamps
-- email_verified_at for audit.

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_email_verification_tokens_hash"
  ON "email_verification_tokens" ("token_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_email_verification_tokens_user"
  ON "email_verification_tokens" ("user_id");
--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;
