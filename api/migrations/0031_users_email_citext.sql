-- Hand-written: Module 1 CON-001 — email as CITEXT for DB-enforced
-- case-insensitive uniqueness. Application code already lowercases at
-- write time; CITEXT removes the reliance on every call site doing so
-- correctly + makes ad-hoc admin queries case-insensitive without
-- LOWER() wrapping.

CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

ALTER TABLE "users" ALTER COLUMN "email" TYPE citext;
