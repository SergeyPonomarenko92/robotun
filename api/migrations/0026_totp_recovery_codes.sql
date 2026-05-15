-- Hand-written: Module 1 — TOTP backup/recovery codes.
-- Generated alongside enrollment; one-time use; lets the user recover
-- access when they lose the authenticator device. Stored as sha256 hash
-- of a 10-char A-Z0-9 plaintext.

CREATE TABLE IF NOT EXISTS "totp_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_totp_recovery_codes_hash"
  ON "totp_recovery_codes" ("code_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_totp_recovery_codes_user"
  ON "totp_recovery_codes" ("user_id");
