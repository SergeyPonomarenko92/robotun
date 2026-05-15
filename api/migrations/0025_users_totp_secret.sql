-- Hand-written: Module 1 — TOTP secret column for MFA enrollment.
-- Plaintext base32 in v1 (dev expediency); prod should swap to a
-- KMS-encrypted blob or pgcrypto pgp_sym_encrypt. mfa_enrolled stays as
-- the user-facing boolean; totp_secret presence ≠ enrollment until the
-- first /me/mfa/totp/verify call.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_secret" text;
