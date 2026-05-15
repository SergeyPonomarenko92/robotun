-- Hand-written: Module 1 REQ-004 — provider_profiles table.
-- Spec contract: provider role elevation creates a row with kyc_status='none'
-- and DOES NOT enable payouts. The boolean users.has_provider_role stays as
-- the fast-path read; this table holds provider-specific business state.
-- Many other modules reference provider_profiles in their specs:
--   - Module 3: completed_deals_count (denorm trigger from deals completion)
--   - Module 7: avg_rating + review_count (denorm trigger from review reveal)
--   - Module 13: provider_quality_score
-- Columns added incrementally as their owning modules ship.

CREATE TABLE IF NOT EXISTS "provider_profiles" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  -- Mirror of users.kyc_status for the provider role specifically. Two
  -- copies exist: users.kyc_status (the auth-context fast-path read) and
  -- provider_profiles.kyc_status (the provider business state). Kept in
  -- sync by the Module 4 service when approving/rejecting.
  "kyc_status" kyc_status_t NOT NULL DEFAULT 'none',
  "headline" text,
  "service_area" text,
  -- Denorm counters seeded at 0; populated by triggers added in
  -- their owning modules.
  "completed_deals_count" integer NOT NULL DEFAULT 0,
  "avg_rating" real,
  "review_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_provider_profiles_kyc"
  ON "provider_profiles" ("kyc_status")
  WHERE kyc_status IN ('approved', 'submitted', 'in_review');
