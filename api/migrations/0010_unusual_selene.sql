DO $$ BEGIN
 CREATE TYPE "public"."dispute_party_role" AS ENUM('client', 'provider');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispute_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"party_role" "dispute_party_role" NOT NULL,
	"uploader_user_id" uuid,
	"reason" text,
	"statement" text,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gdpr_erased_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_dispute_evidence_deal_role" ON "dispute_evidence" USING btree ("deal_id","party_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dispute_evidence_deal" ON "dispute_evidence" USING btree ("deal_id");--> statement-breakpoint

ALTER TABLE "dispute_evidence"
  ADD CONSTRAINT "chk_statement_length"
  CHECK (statement IS NULL OR char_length(statement) BETWEEN 30 AND 4000);
