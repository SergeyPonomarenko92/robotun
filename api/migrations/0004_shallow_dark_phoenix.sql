DO $$ BEGIN
 CREATE TYPE "public"."kyc_doc_verification_status" AS ENUM('pending', 'accepted', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."kyc_document_type" AS ENUM('passport_ua', 'passport_foreign', 'id_card', 'rnokpp', 'fop_certificate', 'selfie');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."kyc_verification_status" AS ENUM('not_submitted', 'submitted', 'in_review', 'approved', 'rejected', 'expired', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kyc_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kyc_verification_id" uuid NOT NULL,
	"provider_id" uuid,
	"document_type" "kyc_document_type" NOT NULL,
	"media_id" uuid,
	"document_number_enc" text,
	"full_name_enc" text,
	"date_of_birth_enc" text,
	"kek_version" text DEFAULT 'v1' NOT NULL,
	"document_expires_at" date,
	"verification_status" "kyc_doc_verification_status" DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"submission_index" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kyc_review_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kyc_verification_id" uuid NOT NULL,
	"provider_id" uuid,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kyc_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid,
	"status" "kyc_verification_status" DEFAULT 'not_submitted' NOT NULL,
	"submitted_at" timestamp with time zone,
	"review_started_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rejection_code" text,
	"rejection_note" text,
	"rekyc_required_reason" text,
	"rekyc_required_at" timestamp with time zone,
	"reviewed_by" uuid,
	"submission_count" integer DEFAULT 0 NOT NULL,
	"submission_limit" integer DEFAULT 5 NOT NULL,
	"last_decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kyc_verification_id_kyc_verifications_id_fk" FOREIGN KEY ("kyc_verification_id") REFERENCES "public"."kyc_verifications"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyc_review_events" ADD CONSTRAINT "kyc_review_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kyc_docs_verification" ON "kyc_documents" USING btree ("kyc_verification_id","submission_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kyc_docs_provider" ON "kyc_documents" USING btree ("provider_id","uploaded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kyc_events_kv" ON "kyc_review_events" USING btree ("kyc_verification_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_kyc_provider" ON "kyc_verifications" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kyc_status_queue" ON "kyc_verifications" USING btree ("created_at","status");--> statement-breakpoint

-- Module 4 augmentation: CHECKs + set_updated_at trigger.

ALTER TABLE "kyc_verifications"
  ADD CONSTRAINT "chk_kyc_decided_at" CHECK (
    status NOT IN ('approved','rejected','expired') OR decided_at IS NOT NULL
  );
--> statement-breakpoint
ALTER TABLE "kyc_verifications"
  ADD CONSTRAINT "chk_kyc_submitted_at" CHECK (
    status = 'not_submitted' OR submitted_at IS NOT NULL
  );
--> statement-breakpoint
ALTER TABLE "kyc_verifications"
  ADD CONSTRAINT "chk_kyc_rejection_fields" CHECK (
    status = 'rejected' OR (rejection_code IS NULL AND rejection_note IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "kyc_verifications"
  ADD CONSTRAINT "chk_kyc_rejection_code_enum" CHECK (
    rejection_code IS NULL OR rejection_code IN (
      'document_expired','document_unreadable','document_mismatch',
      'selfie_mismatch','data_inconsistency','unsupported_document_type',
      'incomplete_submission','fraud_suspicion','other'
    )
  );
--> statement-breakpoint
ALTER TABLE "kyc_verifications"
  ADD CONSTRAINT "chk_kyc_submission_limit" CHECK (submission_limit BETWEEN 5 AND 20);
--> statement-breakpoint

ALTER TABLE "kyc_documents"
  ADD CONSTRAINT "chk_kyc_doc_reviewed_at" CHECK (
    verification_status = 'pending' OR reviewed_at IS NOT NULL
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_kyc_verifications_updated_at ON kyc_verifications;
--> statement-breakpoint
CREATE TRIGGER set_kyc_verifications_updated_at
  BEFORE UPDATE ON kyc_verifications
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
--> statement-breakpoint

-- Module 6 chk_purpose_fk_kyc was authored against the spec linkage
-- (media → kyc_documents). MVP inverts ownership: media row holds
-- owner_user_id=provider until KYC service back-references via
-- kyc_documents.media_id. Drop the FK-presence check; chk_exactly_one_owner
-- still guarantees a single owner.
ALTER TABLE "media_objects" DROP CONSTRAINT IF EXISTS "chk_purpose_fk_kyc";
