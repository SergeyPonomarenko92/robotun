DO $$ BEGIN
 CREATE TYPE "public"."deal_status" AS ENUM('pending', 'active', 'in_review', 'completed', 'disputed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."escrow_status" AS ENUM('not_required', 'hold_requested', 'held', 'release_requested', 'released', 'refund_requested', 'refunded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deal_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"listing_id" uuid,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "deal_status" DEFAULT 'pending' NOT NULL,
	"agreed_price" integer NOT NULL,
	"currency" text DEFAULT 'UAH' NOT NULL,
	"escrow_status" "escrow_status" DEFAULT 'not_required' NOT NULL,
	"escrow_hold_id" uuid,
	"escrow_hold_requested_at" timestamp with time zone,
	"escrow_held_at" timestamp with time zone,
	"escrow_released_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"review_started_at" timestamp with time zone,
	"auto_complete_after" timestamp with time zone,
	"dispute_window_until" timestamp with time zone,
	"dispute_opened_at" timestamp with time zone,
	"dispute_resolve_by" timestamp with time zone,
	"cancel_requested_by_client_at" timestamp with time zone,
	"cancel_requested_by_provider_at" timestamp with time zone,
	"cancellation_reason" text,
	"resolution_outcome" text,
	"resolution_release_amount" integer,
	"resolution_note" text,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text,
	"idempotency_body_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deals" ADD CONSTRAINT "deals_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deals" ADD CONSTRAINT "deals_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deals" ADD CONSTRAINT "deals_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deals" ADD CONSTRAINT "deals_resolved_by_admin_id_users_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_events_deal" ON "deal_events" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_events_actor" ON "deal_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_client" ON "deals" USING btree ("client_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_provider" ON "deals" USING btree ("provider_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_listing" ON "deals" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deals_idempotency_key" ON "deals" USING btree ("idempotency_key");--> statement-breakpoint

-- Module 3 augmentation: CHECKs, partial timer indexes, set_updated_at.

ALTER TABLE "deals"
  ADD CONSTRAINT "chk_deals_description" CHECK (char_length(description) BETWEEN 1 AND 5000);
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_deals_price" CHECK (agreed_price > 0);
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_deals_currency_uah" CHECK (currency = 'UAH');
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_client_ne_provider" CHECK (client_id <> provider_id);
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_held_requires_id"
  CHECK (escrow_status <> 'held' OR escrow_hold_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_resolution_amount" CHECK (
    resolution_release_amount IS NULL
    OR (resolution_release_amount >= 0 AND resolution_release_amount <= agreed_price)
  );
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_resolution_outcome" CHECK (
    resolution_outcome IS NULL OR resolution_outcome IN (
      'release_to_provider','refund_to_client','split'
    )
  );
--> statement-breakpoint
ALTER TABLE "deals"
  ADD CONSTRAINT "chk_cancellation_reason" CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'escrow_timeout','dispute_unresolved','provider_suspended',
      'escrow_hold_expired','mutual','rejected_by_provider',
      'cancelled_by_client'
    )
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_deals_status_timer"
  ON "deals" ("status", "auto_complete_after")
  WHERE status = 'in_review' AND auto_complete_after IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_pending_expiry"
  ON "deals" ("status", "created_at") WHERE status = 'pending';
--> statement-breakpoint

ALTER TABLE "deal_events"
  ADD CONSTRAINT "chk_deal_events_actor_role"
  CHECK (actor_role IN ('client','provider','system','admin'));
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_deal_updated_at ON deals;
--> statement-breakpoint
CREATE TRIGGER set_deal_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
