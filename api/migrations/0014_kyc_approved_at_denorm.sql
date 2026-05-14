-- Module 4 ↔ Module 8: denormalize the "first KYC approval timestamp" onto
-- users so the Feed score can snapshot it via `<= $as_of` without losing
-- the signal when kyc_verifications.status flips back to 'submitted' /
-- 'rejected' on re-submission. Once set, NEVER cleared — represents
-- "the provider was approved at this moment in time, regardless of
-- current state".
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "kyc_approved_at" timestamp with time zone;
--> statement-breakpoint

-- Backfill: any provider whose current kyc_verifications row is approved
-- gets decided_at copied. Providers who were approved-then-revoked lose
-- history in the MVP (no audit table to reconstruct from) — acceptable
-- one-time loss; from this migration forward, kyc.service.approve writes
-- the column.
UPDATE users u
   SET kyc_approved_at = kv.decided_at
  FROM kyc_verifications kv
 WHERE kv.provider_id = u.id
   AND kv.status = 'approved'
   AND kv.decided_at IS NOT NULL
   AND u.kyc_approved_at IS NULL;
