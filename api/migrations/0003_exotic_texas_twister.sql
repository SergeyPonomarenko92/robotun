DO $$ BEGIN
 CREATE TYPE "public"."media_bucket" AS ENUM('quarantine', 'public-media', 'kyc-private');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."media_purpose" AS ENUM('listing_cover', 'listing_gallery', 'listing_attachment', 'kyc_document', 'avatar', 'message_attachment', 'dispute_evidence');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."media_status" AS ENUM('awaiting_upload', 'awaiting_scan', 'ready', 'scan_error', 'scan_error_permanent', 'quarantine_rejected', 'deleted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listing_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"display_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"listing_id" uuid,
	"kyc_document_id" uuid,
	"message_id" uuid,
	"dispute_evidence_id" uuid,
	"purpose" "media_purpose" NOT NULL,
	"storage_key" text NOT NULL,
	"bucket_alias" "media_bucket" NOT NULL,
	"original_filename" text,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum_sha256" text,
	"width_px" integer,
	"height_px" integer,
	"is_public" boolean DEFAULT false NOT NULL,
	"status" "media_status" DEFAULT 'awaiting_upload' NOT NULL,
	"scan_attempts" smallint DEFAULT 0 NOT NULL,
	"last_scan_error" text,
	"scan_error_at" timestamp with time zone,
	"scan_completed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"hard_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_listing_media" ON "listing_media" USING btree ("listing_id","media_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_listing_media_order" ON "listing_media" USING btree ("listing_id","display_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_objects_owner" ON "media_objects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_objects_listing" ON "media_objects" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_objects_orphan" ON "media_objects" USING btree ("created_at");--> statement-breakpoint

-- Module 6 augmentation: CHECKs, partial indexes, single-cover trigger.

ALTER TABLE "media_objects"
  ADD CONSTRAINT "media_objects_byte_size_chk" CHECK (byte_size > 0);
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "media_objects_width_chk" CHECK (width_px IS NULL OR width_px > 0);
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "media_objects_height_chk" CHECK (height_px IS NULL OR height_px > 0);
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "chk_exactly_one_owner" CHECK (
    ((owner_user_id IS NOT NULL)::int +
     (listing_id    IS NOT NULL)::int +
     (kyc_document_id IS NOT NULL)::int +
     (message_id    IS NOT NULL)::int +
     (dispute_evidence_id IS NOT NULL)::int) = 1
  );
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "chk_purpose_fk_listing" CHECK (
    purpose NOT IN ('listing_cover','listing_gallery','listing_attachment')
    OR listing_id IS NOT NULL
  );
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "chk_purpose_fk_kyc" CHECK (
    purpose <> 'kyc_document' OR kyc_document_id IS NOT NULL
  );
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "chk_purpose_fk_user" CHECK (
    purpose <> 'avatar' OR owner_user_id IS NOT NULL
  );
--> statement-breakpoint
ALTER TABLE "media_objects"
  ADD CONSTRAINT "chk_kyc_private_bucket" CHECK (
    purpose <> 'kyc_document'
    OR (bucket_alias = 'kyc-private' AND is_public = false)
  );
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_media_objects_owner";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_media_objects_listing";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_media_objects_orphan";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_objects_owner"
  ON "media_objects" ("owner_user_id") WHERE status <> 'deleted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_objects_listing"
  ON "media_objects" ("listing_id") WHERE listing_id IS NOT NULL AND status = 'ready';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_media_objects_orphan"
  ON "media_objects" ("created_at") WHERE status = 'awaiting_upload';
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_media_objects_updated_at ON media_objects;
--> statement-breakpoint
CREATE TRIGGER set_media_objects_updated_at
  BEFORE UPDATE ON media_objects
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
--> statement-breakpoint

-- §4.2 single-cover invariant (P0001 reused for listing-domain).
CREATE OR REPLACE FUNCTION trg_enforce_single_cover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT purpose FROM media_objects WHERE id = NEW.media_id) = 'listing_cover' THEN
    IF EXISTS (
      SELECT 1
      FROM listing_media lm
      JOIN media_objects mo ON mo.id = lm.media_id
      WHERE lm.listing_id = NEW.listing_id
        AND mo.purpose = 'listing_cover'
        AND lm.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'listing already has a cover image' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS enforce_single_cover ON listing_media;
--> statement-breakpoint
CREATE TRIGGER enforce_single_cover
  BEFORE INSERT OR UPDATE ON listing_media
  FOR EACH ROW EXECUTE FUNCTION trg_enforce_single_cover();
