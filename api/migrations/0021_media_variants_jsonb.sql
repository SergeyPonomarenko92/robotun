-- Hand-written: Module 6 — variants JSONB, replacing thumbnail_key +
-- preview_key columns. Keeps the legacy columns for one cycle so any
-- in-flight FE consumer reading them directly doesn't break; v22+
-- migration will DROP them after FE audit.
--
-- Schema: { thumbnail: <key>, preview: <key>, [thumbnail_2x]: <key>, ... }.
-- Keys are storage_key paths within the same bucket as the original.

ALTER TABLE "media_objects"
  ADD COLUMN IF NOT EXISTS "variants" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- Backfill: lift existing legacy column values into the JSONB map.
UPDATE "media_objects"
   SET "variants" = jsonb_strip_nulls(jsonb_build_object(
         'thumbnail', "thumbnail_key",
         'preview',   "preview_key"
       ))
 WHERE ("thumbnail_key" IS NOT NULL OR "preview_key" IS NOT NULL)
   AND "variants" = '{}'::jsonb;
