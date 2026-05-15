-- Hand-written: Module 6 preview variant (640px wide, webp).
-- Same pattern as 0017 thumbnail_key. Generated after clean ClamAV scan
-- for image purposes; served via /media/:id/stream?variant=preview.
--
-- Two columns rather than a JSONB variants map — v1 keeps the shape
-- predictable; v2 will swap both columns to JSONB when retina @2x +
-- arbitrary sizes need to coexist.

ALTER TABLE "media_objects" ADD COLUMN IF NOT EXISTS "preview_key" text;
