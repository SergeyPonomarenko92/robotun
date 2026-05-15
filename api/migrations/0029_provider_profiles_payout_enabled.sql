-- Hand-written: REQ-004 critic RISK-6 — schema divergence with auth spec §4.1
-- and KYC spec SEC-007. provider_profiles needs payout_enabled column with
-- CHECK so the Payments module gets a defense-in-depth DB-level guard
-- joining users + provider_profiles.

ALTER TABLE "provider_profiles"
  ADD COLUMN IF NOT EXISTS "payout_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "provider_profiles"
  DROP CONSTRAINT IF EXISTS "chk_provider_profiles_payout_kyc";
--> statement-breakpoint

ALTER TABLE "provider_profiles"
  ADD CONSTRAINT "chk_provider_profiles_payout_kyc"
  CHECK (NOT payout_enabled OR kyc_status = 'approved');
