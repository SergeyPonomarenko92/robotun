DO $$ BEGIN
 CREATE TYPE "public"."category_proposal_status" AS ENUM('pending', 'approved', 'rejected', 'auto_rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."category_status" AS ENUM('active', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"level" smallint NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "category_status" DEFAULT 'active' NOT NULL,
	"creator_id" uuid,
	"admin_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "category_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposer_id" uuid,
	"parent_category_id" uuid NOT NULL,
	"proposed_name" text NOT NULL,
	"proposed_slug" text NOT NULL,
	"status" "category_proposal_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_code" text,
	"rejection_note" text,
	"auto_rejected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "category_proposals" ADD CONSTRAINT "category_proposals_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "category_proposals" ADD CONSTRAINT "category_proposals_parent_category_id_categories_id_fk" FOREIGN KEY ("parent_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "category_proposals" ADD CONSTRAINT "category_proposals_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_categories_parent_active" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_status_created" ON "category_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_proposer" ON "category_proposals" USING btree ("proposer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_pending_ready" ON "outbox_events" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint

-- Module 10 (DAT-001) hand-written augmentation: CHECKs, self-FK,
-- partial unique indexes, triggers. drizzle-kit cannot generate these.

ALTER TABLE "categories"
  ADD CONSTRAINT "categories_level_chk" CHECK (level BETWEEN 1 AND 3);
--> statement-breakpoint
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_name_chk" CHECK (char_length(name) BETWEEN 2 AND 120);
--> statement-breakpoint
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_slug_chk" CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$');
--> statement-breakpoint
ALTER TABLE "category_proposals"
  ADD CONSTRAINT "proposals_name_chk" CHECK (char_length(proposed_name) BETWEEN 2 AND 120);
--> statement-breakpoint
ALTER TABLE "category_proposals"
  ADD CONSTRAINT "proposals_slug_chk" CHECK (proposed_slug ~ '^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$');
--> statement-breakpoint
ALTER TABLE "category_proposals"
  ADD CONSTRAINT "proposals_rejection_code_chk" CHECK (
    rejection_code IS NULL OR rejection_code IN (
      'duplicate_category','max_depth_exceeded','parent_archived',
      'policy_violation','proposer_deleted','admin_override'
    )
  );
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_categories_parent_active";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_proposals_status_created";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_proposals_proposer";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_outbox_pending_ready";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_category_slug_active"
  ON "categories" ("slug") WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_category_name_sibling"
  ON "categories" (LOWER("name"), COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_categories_parent_active"
  ON "categories" ("parent_id") WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_status_created"
  ON "category_proposals" ("status","created_at") WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposals_proposer"
  ON "category_proposals" ("proposer_id","created_at" DESC) WHERE proposer_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_proposal_slug_pending"
  ON "category_proposals" ("proposed_slug") WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_pending_ready"
  ON "outbox_events" ("next_retry_at") WHERE status = 'pending';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_check_category_level()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_level smallint;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.level := 1;
  ELSE
    SELECT level INTO parent_level FROM categories WHERE id = NEW.parent_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF parent_level >= 3 THEN
      RAISE EXCEPTION 'max_depth_exceeded' USING ERRCODE = 'P0003';
    END IF;
    NEW.level := parent_level + 1;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS check_category_level ON categories;
--> statement-breakpoint
CREATE TRIGGER check_category_level BEFORE INSERT ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_check_category_level();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_deny_category_reparent()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'category_reparent_forbidden' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS deny_category_reparent ON categories;
--> statement-breakpoint
CREATE TRIGGER deny_category_reparent BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_deny_category_reparent();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_set_category_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_category_updated_at ON categories;
--> statement-breakpoint
CREATE TRIGGER set_category_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_set_category_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_deny_category_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'category_delete_forbidden' USING ERRCODE = 'P0005';
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS deny_category_delete ON categories;
--> statement-breakpoint
CREATE TRIGGER deny_category_delete BEFORE DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_deny_category_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_categories_pending_slug_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM category_proposals
    WHERE proposed_slug = NEW.slug AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'duplicate_category' USING ERRCODE = 'P0006';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS categories_pending_slug_check ON categories;
--> statement-breakpoint
CREATE TRIGGER categories_pending_slug_check BEFORE INSERT ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_categories_pending_slug_check();
