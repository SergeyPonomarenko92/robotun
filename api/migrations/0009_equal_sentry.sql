DO $$ BEGIN
 CREATE TYPE "public"."payout_status" AS ENUM('requested', 'processing', 'completed', 'failed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"amount_kopecks" integer NOT NULL,
	"target_last4" text,
	"status" "payout_status" DEFAULT 'requested' NOT NULL,
	"failure_reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payouts_provider" ON "payouts" USING btree ("provider_id","requested_at");--> statement-breakpoint

ALTER TABLE "payouts"
  ADD CONSTRAINT "chk_payout_amount" CHECK (amount_kopecks > 0);
