---
title: Media Pipeline — Upload, Storage, Processing, Access
version: 1.1
date_created: 2026-05-06
last_updated: 2026-05-08
owner: Platform / Backend
tags: [architecture, media, storage, s3, kyc, listings]
---

# Introduction

This module specifies the **Media Pipeline** subsystem: a single, purpose-keyed pipeline that owns the lifecycle of every binary object in the platform — listing covers and galleries, listing attachments, user avatars, and KYC documents. It exposes a uniform upload/confirm/read API used directly by clients and proxied by domain modules (KYC). All scan, retention, access-control, and storage policies are concentrated here so that consuming modules cannot diverge.

This spec **supersedes** the `listing_media` table definition in `spec-architecture-listings.md` §4.2.

## 1. Purpose & Scope

Define the data model, upload flow, async processing pipeline, access-control surface, retention rules, and operational guards for binary media in the Robotun marketplace.

**In scope.** Storage layout, two-phase presigned upload, virus scanning, image variant generation, public vs. restricted read paths, lifecycle/retention sweeps, rate limiting, observability.

**Out of scope.** Video transcoding/HLS, S3 multi-part upload, client-side compression, content moderation (nudity/hate-symbol detection), `deal_attachment` purpose (deferred to a future Deal-attachments / Messaging module), per-Provider storage quotas, KMS rotation runbook, media analytics.

**Audience.** Backend engineers, infra engineers, KYC reviewers' tooling team, Listings/Reviews/Messaging module owners.

**Assumptions.** PostgreSQL 15+; S3-compatible object store; `pgmq` extension available; CloudFront available for CDN; `users`, `listings`, `kyc_documents`, `kyc_verifications`, `kyc_review_events` tables already exist per their respective specs.

## 2. Definitions

| Term | Definition |
|---|---|
| Media object | A row in `media_objects` representing one logical binary, with state machine, owner FK, purpose, and pointers to its variants. |
| Variant | A derived rendition of a media object (e.g., `thumb_256`, `webp_800`); `original` is also a variant entry. |
| Purpose | Enumerated label classifying a media object: `listing_cover`, `listing_gallery`, `listing_attachment`, `kyc_document`, `avatar`. |
| Quarantine bucket | `robotun-quarantine` — short-lived staging bucket where presigned POST uploads land; 2-hour S3 lifecycle auto-delete; no read access from outside the API service. |
| Public bucket | `robotun-public-media` — origin for CDN-served public assets; reachable only via CloudFront OAC. |
| KYC private bucket | `robotun-kyc-private` — encrypted with a dedicated KMS CMK; never CDN-fronted; readable only via API streaming proxy. |
| Presigned POST | S3 browser-form upload with embedded policy document; supports `content-length-range` enforcement. |
| Stream endpoint | `GET /media/{id}/stream` — single read path for all purposes; emits public Cache-Control for public purposes, streams bytes via API for KYC. |
| Confirm | Client call after S3 upload completes; transitions media object from `awaiting_upload` to `awaiting_scan` and enqueues async scan/processing. |
| Reconciliation sweep | Periodic job that re-enqueues media stuck in `scan_error` while ClamAV is healthy. |
| `decided_at` | Timestamp of KYC admin approve/reject decision (KYC spec §4.11) — anchor for KYC retention. |

## 3. Requirements, Constraints & Guidelines

### Functional requirements

- **REQ-001** The system SHALL expose `POST /media/uploads/initiate` returning an S3 presigned POST envelope (URL + form fields including a policy document) for uploading directly to the quarantine bucket.
- **REQ-002** The system SHALL expose `POST /media/uploads/confirm` which performs a HEAD against the quarantine object, transitions the media object to `awaiting_scan`, enqueues an async scan/processing job, and returns HTTP 202.
- **REQ-003** The system SHALL expose `GET /media/{id}/stream` as the **only** read path for media bytes. Response Cache-Control varies by purpose (see §4.6).
- **REQ-004** The system SHALL expose `GET /media/{id}` returning sanitized metadata only (no `storage_key`, no `bucket_alias`, no internal paths).
- **REQ-005** The system SHALL expose `DELETE /media/{id}` performing a soft delete (sets `deleted_at`).
- **REQ-006** The system SHALL expose `GET /media` listing the caller's own non-KYC media objects (cursor-paginated on `(created_at DESC, id)`); `purpose='kyc_document'` rows MUST be excluded from this endpoint.
- **REQ-007** The KYC endpoints `POST /kyc/me/uploads/initiate` and `POST /kyc/me/uploads/confirm` SHALL be thin proxies that inject `purpose='kyc_document'` and `kyc_document_id` (caller's pending document slot) and call the same internal handlers as the generic media endpoints. No separate code path.
- **REQ-008** The async worker SHALL run ClamAV against every uploaded object before any subsequent processing or promotion.
- **REQ-009** On clean scan, the worker SHALL perform a server-side S3 COPY from quarantine to the target bucket (`kyc-private` for `kyc_document`; `public-media` otherwise), DELETE the quarantine object, and transition status to `ready`.
- **REQ-010** The worker SHALL generate two image variants (`thumb_256`, `webp_800`) plus retain `original` for image purposes; PDFs (KYC documents) SHALL be structurally validated only — no variants generated.
- **REQ-011** Image processing SHALL strip EXIF metadata unconditionally and re-encode to normalized JPEG (q=85) or WebP for derived variants. Originals are retained as-is.
- **REQ-012** `expires_at` for `kyc_document` rows SHALL be set exclusively by the KYC module in its `kyc.decided` event handler — `decided_at + 3 years` for approved, `decided_at + 90 days` for rejected. The Media Pipeline MUST NOT compute or override `expires_at` for KYC purpose.
- **REQ-013** Listing-media public visibility SHALL be derived at read time by joining `listings.status='active'`. `media_objects.is_public` SHALL NOT be relied upon as the public-access gate for listing media.
- **REQ-014** The system SHALL enforce per-listing media caps at `POST /media/uploads/initiate` using `pg_advisory_xact_lock(hashtext('listing_media'), hashtext(lower(listing_id::text)))` followed by COUNT-then-INSERT in the same transaction.
- **REQ-015** The system SHALL enforce a per-user upload rate limit of 100 initiations per rolling hour using a partitioned counter table `media_upload_rate`. Exceeding returns HTTP 429.

### Security requirements

- **SEC-001** KYC documents SHALL never be served via a CDN, signed URL, or any path other than the API streaming proxy at `GET /media/{id}/stream`. The KYC private bucket SHALL have no CloudFront distribution and zero public-access policies.
- **SEC-002** The KYC private bucket SHALL be encrypted with a dedicated KMS CMK distinct from the public-media key. IAM access to the KYC CMK is restricted to the media service role and the KYC reviewer role.
- **SEC-003** `GET /media/{id}/stream` and `GET /media/{id}` SHALL return identical 404 responses for both nonexistent media and media the caller is not authorized to know exists.
- **SEC-004** Error responses SHALL NOT include `storage_key`, `bucket_alias`, presigned URLs, or any other internal storage identifier.
- **SEC-005** Presigned URLs and file bytes SHALL NOT be written to application logs at any level.
- **SEC-006** KYC document reads via the streaming proxy require the caller to be either the owning Provider or hold the `kyc_reviewer` role; every such read SHALL be appended to the KYC audit trail (see KYC SEC-009).
- **SEC-007** `media_objects.purpose='kyc_document'` rows SHALL NOT appear in any response body of `GET /media`, `GET /media/{id}`, or any non-KYC endpoint.
- **SEC-008** `POST /media/uploads/initiate` SHALL embed a `content-length-range` condition in the presigned POST policy that bounds the upload to `[1, declared_size_bytes + 1024]` bytes; S3 enforces this natively before any bytes reach the application.
- **SEC-009** KYC bucket S3 access logs SHALL be retained for 1 year (alignment with KYC SEC-009).

### Patterns

- **PAT-001** Single upload code path. KYC and non-KYC uploads share `/media/uploads/initiate` and `/media/uploads/confirm` internals; the KYC-domain endpoints are proxies that inject scope.
- **PAT-002** Two-phase upload. Initiate (server reserves `media_objects` row in `awaiting_upload` and returns presigned POST) → S3 POST → Confirm (server HEAD-checks, transitions to `awaiting_scan`, enqueues job, returns 202).
- **PAT-003** Quarantine-then-promote. All uploads land in the quarantine bucket. Promotion (server-side COPY → DELETE quarantine) happens only after a clean ClamAV scan.
- **PAT-004** Async scan with reconciliation. ClamAV runs out-of-band with a 30s per-scan timeout; transient failures route to `scan_error` and are retried up to 3 times by a 5-minute reconciliation sweep; final failures route to `scan_error_permanent`.
- **PAT-005** Single read endpoint. `GET /media/{id}/stream` serves all purposes; per-purpose Cache-Control headers determine CDN cacheability.
- **PAT-006** Purpose-keyed authorization. Stream endpoint branches on `media_objects.purpose` to apply the correct authorization rule (public-active-listing, owner-only, KYC reviewer, etc.).
- **PAT-007** Outbox events on terminal transitions. `media.scan_clean`, `media.scan_threat`, `media.scan_error_permanent`, `kyc.document_ready`, `kyc.document_scan_failed` are emitted via the standard outbox table for cross-module consumption.

### Constraints

- **CON-001** PostgreSQL 15+; S3-compatible object store; `pgmq` extension available.
- **CON-002** Maximum upload sizes (enforced by the presigned POST `content-length-range` policy):
  - `listing_cover`, `listing_gallery`: 10 MB
  - `listing_attachment`: 10 MB
  - `kyc_document`: 20 MB (alignment with KYC CON-009)
  - `avatar`: 5 MB
- **CON-003** Allowed MIME types per purpose:
  - `listing_cover`, `listing_gallery`, `avatar`: `image/jpeg`, `image/png`, `image/webp`
  - `listing_attachment`: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`
  - `kyc_document`: `image/jpeg`, `image/png`, `application/pdf`
- **CON-004** Image dimension cap: width and height each ≤ 16000 px; exceeding rejects via `status='quarantine_rejected'` with `last_scan_error='dimensions_exceeded'`.
- **CON-005** Presigned POST URL TTL: 15 minutes.
- **CON-006** ClamAV per-scan timeout: 30 seconds. Maximum scan retry attempts: 3 (with 5-minute backoff via reconciliation sweep).
- **CON-007** Quarantine bucket S3 lifecycle: auto-delete objects after 2 hours.
- **CON-008** Soft-delete grace: 7 days for non-KYC; KYC documents bypass this grace and are hard-deleted at `expires_at`.
- **CON-009** Upload rate limit: 100 initiations per rolling hour per `owner_user_id`.
- **CON-010** Per-listing media caps: 1 `listing_cover`, 10 `listing_gallery`, 10 `listing_attachment` (KYC document cap of 6 is enforced by the KYC module, not the Media Pipeline).
- **CON-011** Variant set is fixed at MVP: `original`, `thumb_256` (256×256 cover-cropped), `webp_800` (800px longest edge, aspect-preserved). New variant types are added by INSERT into `media_variant_types`, not by DDL.
- **CON-012** `deal_attachment` purpose value SHALL NOT be added until a Deal-attachments specification is finalized.

### Guidelines

- **GUD-001** Prefer outbox events over direct cross-module DB writes. The KYC module reacts to `media.scan_clean` for KYC documents by recording `decided_at`-anchored `expires_at` later, not by writing into Media Pipeline tables synchronously.
- **GUD-002** Operational SLO target: ClamAV daemon recovery within 30 minutes of failure. Alert thresholds (§4.7) are tuned to that target.
- **GUD-003** When public-image stream RPS sustains > 50 req/s for any 24-hour rolling window, deploy CloudFront in front of `GET /media/{id}/stream`. Origin remains the API service (not direct S3) so authorization and the structural KYC-leak barrier are preserved.
- **GUD-004** Schema changes to the `purpose` enum, scan state machine, or variant set are coordinated migrations — not silent additions. Removing a value is a breaking change for consumers.
- **GUD-005** Future modules (Reviews, Messaging, Deal-attachments) that need binary storage MUST extend this pipeline (new purpose value + owner FK column + per-purpose constraint) rather than building a parallel pipeline.

## 4. Interfaces & Data Contracts

### 4.1 `media_objects` (canonical)

```sql
CREATE TABLE media_objects (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner FKs (exactly one non-null per row).
  owner_user_id        UUID         REFERENCES users(id) ON DELETE SET NULL,
  listing_id           UUID         REFERENCES listings(id) ON DELETE SET NULL,
  kyc_document_id      UUID         REFERENCES kyc_documents(id) ON DELETE SET NULL,
  message_id           UUID,                                                     -- v1.1; FK added in Messaging Module 10 deploy migration

  purpose              TEXT         NOT NULL CHECK (purpose IN (
                          'listing_cover','listing_gallery','listing_attachment',
                          'kyc_document','avatar',
                          'message_attachment'                                    -- v1.1
                       )),

  -- Storage location.
  storage_key          TEXT         NOT NULL,
  bucket_alias         TEXT         NOT NULL CHECK (bucket_alias IN (
                          'quarantine','public-media','kyc-private'
                       )),

  -- Content metadata.
  original_filename    TEXT,
  mime_type            TEXT         NOT NULL,
  byte_size            BIGINT       NOT NULL CHECK (byte_size > 0),
  checksum_sha256      TEXT,
  width_px             INT          CHECK (width_px IS NULL OR width_px > 0),
  height_px            INT          CHECK (height_px IS NULL OR height_px > 0),

  -- Visibility (NB: for listing media, derived from listing.status at read time;
  -- this column is authoritative only for non-listing purposes).
  is_public            BOOLEAN      NOT NULL DEFAULT false,

  -- State machine.
  status               TEXT         NOT NULL DEFAULT 'awaiting_upload'
                         CHECK (status IN (
                           'awaiting_upload','awaiting_scan','ready',
                           'scan_error','scan_error_permanent',
                           'quarantine_rejected','deleted'
                         )),

  -- Scan tracking.
  scan_attempts        SMALLINT     NOT NULL DEFAULT 0,
  last_scan_error      TEXT,
  scan_error_at        TIMESTAMPTZ,
  scan_completed_at    TIMESTAMPTZ,

  -- Lifecycle.
  confirmed_at         TIMESTAMPTZ,
  ready_at             TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,             -- KYC: set by KYC module on kyc.decided
  deleted_at           TIMESTAMPTZ,
  hard_deleted_at      TIMESTAMPTZ,

  -- Audit.
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Owner FK constraints.
  -- v1.1: message_id added; for purpose='message_attachment', owner_user_id IS NULL
  -- (ownership transitively derived via messages.sender_id).
  CONSTRAINT chk_exactly_one_owner CHECK (
    ((owner_user_id   IS NOT NULL)::int +
     (listing_id      IS NOT NULL)::int +
     (kyc_document_id IS NOT NULL)::int +
     (message_id      IS NOT NULL)::int) = 1
  ),
  CONSTRAINT chk_purpose_fk_listing CHECK (
    purpose NOT IN ('listing_cover','listing_gallery','listing_attachment')
    OR listing_id IS NOT NULL
  ),
  CONSTRAINT chk_purpose_fk_kyc CHECK (
    purpose <> 'kyc_document' OR kyc_document_id IS NOT NULL
  ),
  CONSTRAINT chk_purpose_fk_user CHECK (
    purpose <> 'avatar' OR owner_user_id IS NOT NULL
  ),
  CONSTRAINT chk_purpose_fk_message CHECK (                                      -- v1.1
    purpose <> 'message_attachment' OR message_id IS NOT NULL
  ),

  -- KYC must live in the KYC private bucket and never be public.
  CONSTRAINT chk_kyc_private_bucket CHECK (
    purpose <> 'kyc_document'
    OR (bucket_alias = 'kyc-private' AND is_public = false)
  )
);

CREATE INDEX idx_media_objects_owner       ON media_objects (owner_user_id) WHERE status <> 'deleted';
CREATE INDEX idx_media_objects_listing     ON media_objects (listing_id)    WHERE listing_id IS NOT NULL AND status = 'ready';
CREATE INDEX idx_media_objects_kyc         ON media_objects (kyc_document_id) WHERE kyc_document_id IS NOT NULL;
CREATE INDEX idx_media_objects_orphan      ON media_objects (created_at)    WHERE status = 'awaiting_upload';
CREATE INDEX idx_media_objects_scan_retry  ON media_objects (scan_error_at) WHERE status = 'scan_error';
CREATE INDEX idx_media_objects_kyc_expiry  ON media_objects (expires_at)    WHERE purpose = 'kyc_document' AND expires_at IS NOT NULL AND hard_deleted_at IS NULL;
CREATE INDEX idx_media_objects_grace       ON media_objects (deleted_at)    WHERE status = 'deleted' AND hard_deleted_at IS NULL;
CREATE INDEX idx_media_objects_message     ON media_objects (message_id)    WHERE message_id IS NOT NULL AND status = 'ready';  -- v1.1
```

#### 4.1.1 v1.1 — `message_attachment` purpose contract

Added in v1.1 as a hard prerequisite for Messaging Module 10.

- **Purpose value:** `'message_attachment'`.
- **Owner FK:** `message_id` references `messages(id)` ON DELETE SET NULL. **Deploy order:** the `message_id` column ships in Media Pipeline v1.1 WITHOUT a FK (the `messages` table does not yet exist). The FK constraint is added in a follow-up migration that is part of the Messaging Module 10 deploy: `ALTER TABLE media_objects ADD CONSTRAINT fk_media_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL`. Until that migration lands, `message_id` is an unconstrained UUID column populated only by the Messaging service.
- **`owner_user_id` for `message_attachment` rows:** MUST be NULL. Ownership is derived transitively via `messages.sender_id`. The `chk_exactly_one_owner` constraint enforces this (only `message_id` is set).
- **Allowed MIME types** (Messaging REQ-014): `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- **Per-attachment size cap:** 10 MB.
- **Per-message attachment cap:** 5 — enforced by Messaging callers via `pg_advisory_xact_lock(hashtextextended($message_id::text, 0))` (1-arg BIGINT form) followed by `SELECT COUNT(*) FROM media_objects WHERE message_id = $message_id AND status <> 'deleted'`. The Media Pipeline does NOT enforce this cap server-side; it is the consumer's contract (analogous to listing-gallery cap pattern in §9.3).
- **Bucket:** `public-media` (recipient downloads through CDN-fronted stream endpoint with auth check). MIME-restricted; PDFs served with `Content-Disposition: attachment` to prevent browser inline rendering.
- **Visibility:** sender always sees the attachment metadata; recipient access (stream endpoint) is gated on `status = 'ready'`. Threat (`status = 'quarantine_rejected'`) hides the attachment from both parties; Messaging emits `message.attachment_threat` outbox event.
- **Retention:** unlinked when the parent `messages` row is deleted (`ON DELETE SET NULL`); orphan media older than the standard `awaiting_upload` grace are swept by the existing §4.7 lifecycle sweep. No special retention rule for `message_attachment`.

### 4.2 `listing_media` (supersedes `spec-architecture-listings.md` §4.2)

```sql
CREATE TABLE listing_media (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id     UUID         NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  media_id       UUID         NOT NULL REFERENCES media_objects(id),
  display_order  SMALLINT     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_listing_media UNIQUE (listing_id, media_id)
);
CREATE INDEX idx_listing_media_order ON listing_media (listing_id, display_order);
CREATE INDEX idx_listing_media_media ON listing_media (media_id);

-- Single-cover-per-listing invariant (PostgreSQL partial indexes
-- cannot reference other tables, so a trigger is used).
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
END;
$$;
CREATE TRIGGER enforce_single_cover
  BEFORE INSERT OR UPDATE ON listing_media
  FOR EACH ROW EXECUTE FUNCTION trg_enforce_single_cover();
```

The role of a listing media row is derived: `SELECT purpose FROM media_objects WHERE id = listing_media.media_id`.

### 4.3 `media_variants` and reference table

```sql
CREATE TABLE media_variant_types (
  name        TEXT  PRIMARY KEY,
  description TEXT
);
INSERT INTO media_variant_types (name, description) VALUES
  ('original',  'Original uploaded file, EXIF stripped for images'),
  ('thumb_256', '256x256 cover-cropped image variant'),
  ('webp_800',  '800px longest edge, aspect-preserved WebP variant');

CREATE TABLE media_variants (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id     UUID         NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  variant      TEXT         NOT NULL REFERENCES media_variant_types(name),
  storage_key  TEXT         NOT NULL,
  size_bytes   BIGINT       NOT NULL CHECK (size_bytes > 0),
  mime_type    TEXT         NOT NULL,
  width_px     INT          CHECK (width_px IS NULL OR width_px > 0),
  height_px    INT          CHECK (height_px IS NULL OR height_px > 0),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_media_variant UNIQUE (media_id, variant)
);
CREATE INDEX idx_media_variants_media ON media_variants (media_id);
```

### 4.4 `media_upload_rate` (rate limiter)

```sql
CREATE TABLE media_upload_rate (
  owner_user_id  UUID         NOT NULL,
  window_start   TIMESTAMPTZ  NOT NULL,   -- date_trunc('hour', now())
  upload_count   INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_user_id, window_start)
) PARTITION BY RANGE (window_start);

-- Monthly partitions are created by infra automation.
-- Cleanup = DROP PARTITION on any month older than 'now() - 2 months'.
-- Example partition:
-- CREATE TABLE media_upload_rate_2026_05 PARTITION OF media_upload_rate
--   FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

Counter increment (executed inside the initiate transaction):

```sql
INSERT INTO media_upload_rate (owner_user_id, window_start, upload_count)
VALUES ($1, date_trunc('hour', now()), 1)
ON CONFLICT (owner_user_id, window_start)
DO UPDATE SET upload_count = media_upload_rate.upload_count + 1
RETURNING upload_count;
-- if RETURNING > 100: rollback, return HTTP 429.
```

### 4.5 API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/media/uploads/initiate` | Bearer JWT | Reserve `media_objects` row, return presigned POST envelope. |
| POST | `/media/uploads/confirm` | Bearer JWT (owner) | HEAD quarantine object, transition `awaiting_scan`, enqueue scan. Returns 202. |
| GET | `/media/{id}` | Bearer JWT (owner or admin) | Sanitized metadata. KYC documents excluded. |
| GET | `/media/{id}/stream` | Per purpose (see §4.6) | Single read endpoint for all media bytes. |
| DELETE | `/media/{id}` | Bearer JWT (owner) | Soft delete. |
| GET | `/media` | Bearer JWT (owner) | List own media; `purpose='kyc_document'` excluded. Cursor-paginated. |
| POST | `/kyc/me/uploads/initiate` | Bearer JWT (Provider) | Proxy to `/media/uploads/initiate` with `purpose='kyc_document'` injected. |
| POST | `/kyc/me/uploads/confirm` | Bearer JWT (Provider) | Proxy to `/media/uploads/confirm` with caller-scoped validation. |

#### 4.5.1 Initiate request/response

```jsonc
// POST /media/uploads/initiate
{
  "purpose":           "listing_cover",
  "listing_id":        "uuid",          // required for listing_* purposes
  "mime_type":         "image/jpeg",
  "byte_size":         2097152,
  "original_filename": "cover.jpg"
}

// 201 Created
{
  "media_id":   "uuid",
  "method":     "POST",
  "url":        "https://robotun-quarantine.s3.amazonaws.com/",
  "fields": {
    "key":                   "listings/<uuid>/original",
    "Content-Type":          "image/jpeg",
    "x-amz-algorithm":       "AWS4-HMAC-SHA256",
    "x-amz-credential":      "...",
    "x-amz-date":            "...",
    "policy":                "<base64>",
    "x-amz-signature":       "...",
    "success_action_status": "204"
  },
  "expires_at": "2026-05-06T14:30:00Z"
}
```

The embedded policy document:

```json
{
  "expiration": "2026-05-06T14:30:00Z",
  "conditions": [
    {"bucket": "robotun-quarantine"},
    {"key": "listings/<uuid>/original"},
    {"Content-Type": "image/jpeg"},
    ["content-length-range", 1, 2098176]
  ]
}
```

#### 4.5.2 Confirm request/response

```jsonc
// POST /media/uploads/confirm
{
  "media_id":        "uuid",
  "checksum_sha256": "abc..."   // optional, client-computed
}

// 202 Accepted
{
  "media_id": "uuid",
  "status":   "awaiting_scan"
}

// 409 if HEAD finds no quarantine object
{ "error": "upload_not_found" }
```

Confirm is **idempotent**: re-calling on a row already past `awaiting_upload` returns 200 with the current status (no re-enqueue). Calling on `scan_error_permanent` or `quarantine_rejected` returns 409 with `last_scan_error`.

#### 4.5.3 Stream endpoint

```
GET /media/{id}/stream
```

Behavior by purpose:

| Purpose | Authorization | Cache-Control | Body |
|---|---|---|---|
| `listing_cover` / `listing_gallery` | Public **iff** `listings.status='active'`; otherwise owner-only | `public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400` (active) or `private, no-store` (draft) | 302 redirect to S3 OAC URL via CloudFront, OR direct byte stream depending on CDN deployment |
| `listing_attachment` | Owner OR active deal counterparty | `private, no-store` | Direct byte stream |
| `avatar` | Public | `public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400` | 302 / direct stream |
| `kyc_document` | Owner Provider OR `kyc_reviewer` role | `private, no-store` | **Always streamed via API** (no signed URL leaves the API boundary, per KYC REQ-013) |

Forbidden/missing responses:

```jsonc
// 403
{ "error": "forbidden" }

// 404 (returned for both nonexistent and forbidden-existence)
{ "error": "not_found" }
```

Neither response body contains `storage_key`, `bucket_alias`, `stream_url`, or any internal path.

#### 4.5.4 Metadata endpoint

```jsonc
// GET /media/{id}
{
  "id":         "uuid",
  "purpose":    "listing_cover",
  "mime_type":  "image/jpeg",
  "byte_size":  2097152,
  "width_px":   1920,
  "height_px":  1080,
  "status":     "ready",
  "created_at": "2026-05-06T13:30:00Z",
  "variants":   ["original", "thumb_256", "webp_800"]
}
```

`storage_key`, `bucket_alias`, raw S3 URLs, and presigned URLs SHALL NOT appear in any response.

### 4.6 State machine (`media_objects.status`)

```
                  POST /uploads/initiate
                           │
                           ▼
                  ┌─────────────────────┐
                  │  awaiting_upload    │  (S3 presigned POST issued)
                  └──────────┬──────────┘
                             │  POST /uploads/confirm + HEAD ok
                             ▼
                  ┌─────────────────────┐
                  │   awaiting_scan     │  (job enqueued in pgmq)
                  └──────────┬──────────┘
                             │  ClamAV
              ┌──────────────┼──────────────┬──────────────┐
   clean      │    threat    │    timeout/error             │
              ▼              ▼              ▼               ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │    ready     │ │ quarantine_  │ │  scan_error  │ ──reconciliation sweep──┐
    │ (in target   │ │  rejected    │ └──────┬───────┘   (5min, max 3 retries) │
    │   bucket)    │ └──────────────┘        │                                 │
    └──────┬───────┘                         │ retries exhausted               │
           │ DELETE /media/{id}              ▼                                 │
           ▼                       ┌────────────────────┐                      │
    ┌──────────────┐                │ scan_error_perm.   │                      │
    │   deleted    │                └────────────────────┘                      │
    └──────────────┘                                                           │
                                            │  re-enqueue on health recovery   │
                                            └──────────────────────────────────┘
                                            (returns to awaiting_scan)
```

### 4.7 Lifecycle sweeps

| Sweep | Cadence | Action |
|---|---|---|
| Orphan upload sweep | every 15 min | DELETE rows with `status='awaiting_upload' AND created_at < now() - interval '2 hours'`. Quarantine S3 objects already gone via 2h lifecycle. |
| Scan reconciliation sweep | every 5 min | For rows with `status='scan_error' AND scan_attempts < 3 AND scan_error_at < now() - interval '5 minutes'`: re-enqueue, increment `scan_attempts`. After 3rd failure: `status='scan_error_permanent'`, alert. |
| Soft-delete grace sweep | daily | For non-KYC rows with `status='deleted' AND deleted_at < now() - interval '7 days' AND hard_deleted_at IS NULL`: S3 DELETE all variants + original, set `hard_deleted_at = now()`. |
| KYC retention sweep | daily | For rows with `purpose='kyc_document' AND expires_at <= now() AND hard_deleted_at IS NULL`: in one statement, set `deleted_at = hard_deleted_at = now()`; immediately S3 DELETE from `robotun-kyc-private`. **Bypasses the 7-day grace.** |
| DB row purge | daily | DELETE rows where `hard_deleted_at < now() - interval '30 days'` AND `purpose <> 'kyc_document'`. KYC rows are retained per KYC §4.11 (file_key cleared, row shell remains for audit). |

### 4.8 Outbox events emitted

| Event | When | Consumed by |
|---|---|---|
| `media.scan_clean` | Worker promotes object to `ready` | (no current consumer for non-KYC) |
| `media.scan_threat` | Worker sets `quarantine_rejected` | Notifications module |
| `media.scan_error_permanent` | Reconciliation sweep exhausts retries | Notifications + ops alerting |
| `kyc.document_ready` | Worker promotes a `kyc_document` to `ready` | KYC submission flow |
| `kyc.document_scan_failed` | KYC document hits `quarantine_rejected` or `scan_error_permanent` | KYC submission flow + Notifications |
| `media.deleted` | Soft-delete grace sweep or KYC retention sweep performs hard delete | CDN invalidation worker |

## 5. Acceptance Criteria

- **AC-001** Given a Provider with no open KYC submission, when they call `POST /kyc/me/uploads/initiate`, then the proxy returns HTTP 409 `no_open_submission` and no `media_objects` row is created.
- **AC-002** Given a client uses a presigned POST URL, when the client uploads a file exceeding `declared_size_bytes + 1024` bytes, then S3 rejects the upload with HTTP 400 before the application is involved and no quarantine object exists.
- **AC-003** Given a `kyc_document` upload completes its quarantine PUT, when the worker scan returns clean, then the object is server-side COPIED to `robotun-kyc-private`, the quarantine object is deleted, `media_objects.status='ready'`, and `kyc.document_ready` is emitted.
- **AC-004** Given ClamAV is unavailable, when a confirm call is made, then confirm still returns 202; the worker job retries up to 3 times via the reconciliation sweep; the API request never blocks on ClamAV.
- **AC-005** Given a listing transitions from `active` to `paused`, when a public client requests `GET /media/{id}/stream` for one of its gallery images, then the response is 403 (or, if behind CloudFront with cached active-state response, expires within `max-age` and re-validates).
- **AC-006** Given a KYC document's owning Provider has been approved on `decided_at = 2026-05-06`, when 3 years pass and the daily KYC retention sweep runs, then both `deleted_at` and `hard_deleted_at` are set in the same statement, the S3 object is deleted, and no soft-delete grace period is applied.
- **AC-007** Given two concurrent `POST /media/uploads/initiate` calls for the same `listing_id` and `purpose='listing_gallery'` with 10 existing rows, when both attempt to insert, then exactly one succeeds and the other receives HTTP 422 `gallery_limit_exceeded`.
- **AC-008** Given a caller authenticates as a non-owner non-admin, when they request `GET /media/{id}/stream` for someone else's KYC document, then the response is HTTP 404 (not 403) and the body is `{"error":"not_found"}` with no leakage of storage paths.
- **AC-009** Given a media object has `purpose='kyc_document'`, when any caller (including the owner) requests `GET /media`, then no `kyc_document` row appears in the response.
- **AC-010** Given a user has performed 100 upload initiations within the current hour window, when they call `POST /media/uploads/initiate` a 101st time, then the response is HTTP 429 and the rate-limiter row's `upload_count` is rolled back to 100.
- **AC-011** Given an `INSERT` is attempted into `listing_media` referencing a `media_objects` row with `purpose='listing_cover'` for a listing that already has a cover, when the trigger fires, then the INSERT is rejected with `P0001 listing already has a cover image`.
- **AC-012** Given an attempt to insert a `media_objects` row with `purpose='kyc_document'` and `bucket_alias='public-media'`, when the constraint is checked, then the INSERT fails on `chk_kyc_private_bucket`.
- **AC-013** Given the KYC `kyc.decided` event fires for a rejected submission with `decided_at=2026-05-06`, when the KYC handler runs, then `media_objects.expires_at` for that submission's documents is set to `2026-08-04` (90 days later); the Media Pipeline does not compute this.
- **AC-014** Given a `media_objects` row with `purpose='listing_cover'` and `listing_id IS NULL`, when an INSERT is attempted, then `chk_purpose_fk_listing` rejects it.
- **AC-015** Given a confirm call is retried after a network timeout, when the row already has `status='awaiting_scan'`, then the second confirm returns HTTP 200 with the current status and does not enqueue a duplicate scan job.

## 6. Test Automation Strategy

- **Test levels.** Unit (handler logic, policy-document construction, state-machine guards), Integration (Postgres + LocalStack S3 + pgmq), Contract (presigned POST policy validation against real S3), End-to-End (KYC + Listings flows exercising the unified upload path).
- **Frameworks.** Project-default (Postgres-based fixtures, container-based S3 via LocalStack, ClamAV in test mode with EICAR test signature).
- **Test data management.** Per-test transactional rollback for DB rows; per-test bucket prefix for S3 objects (`testrun-<uuid>/...`) cleaned by lifecycle rule.
- **CI/CD integration.** Migrations applied via test harness; LocalStack and ClamAV containers brought up by docker-compose in CI. ClamAV scan tests use the EICAR string for deterministic threat detection.
- **Coverage.** ≥ 90% for state-machine transitions, authorization branches, policy-document construction. Lifecycle sweeps exercised via time-travel tests (`SET LOCAL TIMEZONE` and parameterized `now()`).
- **Performance testing.** Load test the stream endpoint at 100 RPS for `listing_cover`/`listing_gallery` purposes; verify Cache-Control honored and DB JOIN-on-listings remains under 5 ms p95. ClamAV throughput test with 100 concurrent 10MB uploads.
- **Security tests.** EICAR upload must result in `quarantine_rejected`. Negative tests for: presigned POST size overflow, IDOR on `GET /media/{id}/stream`, `GET /media` filtering of `kyc_document`, error-response leakage of storage paths.

## 7. Rationale & Context

### Single upload path

Two parallel upload endpoints (one for KYC, one for everything else) duplicate the most security-sensitive code in the system: the bridge between unauthenticated bytes and trusted storage. Drift between the two implementations is a near-certainty over time. The unified path with thin KYC proxies (REQ-007, PAT-001) keeps the AV/quarantine/copy pipeline single-sourced. The cost — slightly more abstraction at the proxy layer — is acceptable.

### Presigned POST over presigned PUT

Presigned PUT URLs in S3 have **no native upper-bound size enforcement**. A client receiving a presigned PUT for a 2 MB upload can use it to upload a 5 GB file; S3 will accept it. Presigned POST embeds a policy document with `content-length-range` that S3 enforces before the bytes are written. For a marketplace storing PII (KYC) and serving public images, structural size enforcement at the storage layer is non-negotiable. The cost — clients send `multipart/form-data` instead of a raw PUT body — is universally supported.

### Quarantine-then-promote, async scan

The KYC spec REQ-005 already mandates quarantine-then-promote. Generalizing it to all purposes simplifies the codebase and makes the AV layer a structural boundary rather than a KYC-specific feature. Running ClamAV synchronously in the confirm handler (the R1 design) couples the upload UX latency to ClamAV's worst-case scan time and creates outage cascades when ClamAV is degraded. Async scan with reconciliation (PAT-004) decouples the two: the API is always fast; the scan happens out of band; transient failures self-heal.

### KYC retention anchor is `decided_at`, not upload time

The KYC spec §4.11 anchors the 3-year (approved) and 90-day (rejected) retention windows on `decided_at` — the admin's approve/reject timestamp. Computing retention from upload time would underestimate the window by hours-to-days and risks deleting documents still within the legal window for dispute defense (ЦК ст. 257). The Media Pipeline therefore does not compute KYC retention at all (REQ-012); the KYC module writes `expires_at` in its `kyc.decided` event handler.

### Listing public visibility derived at read time

Flipping `media_objects.is_public` asynchronously via a `listing.published` event handler creates a race window where the listing is publicly visible but its images return 403. The race in either direction (publish or unpublish) corrupts the user experience. Joining `listings.status='active'` at read time (REQ-013) eliminates the race by removing the cached gate.

### `purpose` is the source of truth; `listing_media.role` removed

R2 had a `purpose` enum (`listing_image`, `listing_attachment`) and a separate `listing_media.role` (`cover`, `gallery`, `attachment`). These are two enumerations describing the same dimension and will drift. Collapsing to a single dimension (`purpose`, with three listing-related values) and removing `role` from `listing_media` makes the model unambiguous (NEW-3 / R3).

### Two-arg advisory lock for gallery cap

`pg_advisory_xact_lock(hashtext(uuid::text))` keys into `INT4` (~2.1 billion values). Birthday-paradox collisions appear at ~46k concurrent listing IDs, which is small for a production marketplace. The two-arg form combines two `INT4`s into the full `INT8` keyspace and effectively eliminates accidental collisions.

### Postgres-native rate limiter

No other module in the platform uses Redis. Adding Redis solely for a rate counter introduces an operational dependency (failover, eviction config, persistence model) that pays no other rent. A partitioned Postgres counter with monthly `DROP PARTITION` cleanup gives constant-time GC and zero new infrastructure.

### CDN origin = API, not direct S3

A direct-S3 public bucket origin would shave one hop but would put KYC-class objects and public-class objects in the same trust domain, where a single bucket-policy bug can leak KYC documents. Keeping the API as the CDN origin preserves the structural barrier (KYC bucket has zero public path) at the cost of one extra hop on cache-miss.

### Variant set as reference table

A `CHECK (variant IN (...))` constraint requires `AccessExclusiveLock` on the variants table to extend, which is a write outage on a potentially large table. A reference table FK gives the same correctness guarantee with online-extensibility (INSERT into the small reference table, no DDL on the big one).

### Hard cap: orchestration

This module went architect-R1 → critic-R1 (REJECT, 13 risks) → architect-R2 (refinements) → critic-R2 (REJECT, 9 NEW correction-class risks) → architect-R3 (corrections). The R3 round addressed all NEW risks as concrete, scoped corrections. Per the orchestration protocol, this constitutes convergence within the 2-refinement hard cap when the second round is correction-class only (matching the established pattern from Module 5).

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** S3-compatible object store — three buckets (`robotun-quarantine`, `robotun-public-media`, `robotun-kyc-private`); supports presigned POST with `content-length-range`, server-side COPY, KMS encryption, lifecycle rules.
- **EXT-002** CloudFront (or equivalent CDN) — Origin Access Control to `robotun-public-media`; deployed in front of `GET /media/{id}/stream` once §GUD-003 trigger fires.
- **EXT-003** ClamAV daemon — invoked from media processing workers via `clamdscan --stream`; freshclam updater process; signature DB age alerted if > 24 h.
- **EXT-004** KMS — dedicated CMK for `robotun-kyc-private`; shared media CMK for `robotun-public-media` (or SSE-S3 equivalent).

### Third-Party Services
- **SVC-001** AWS S3 (or S3-compatible) — 99.99% availability SLA expectation; SDK access via media-service IAM role.
- **SVC-002** AWS CloudFront (or equivalent CDN) — only after GUD-003 trigger; cache invalidation API used by `media.deleted` consumer.

### Infrastructure Dependencies
- **INF-001** PostgreSQL 15+ with `pgmq` extension for queue and `pg_cron` (or external scheduler) for sweeps.
- **INF-002** Stateless media processing worker pool; scales horizontally on pgmq queue depth.
- **INF-003** ClamAV sidecar/container colocated with the worker pool; not exposed externally.
- **INF-004** Prometheus + alerting stack for the metrics in §6 below.

### Data Dependencies
- **DAT-001** `users.id` (Auth module) — owner FK source.
- **DAT-002** `listings.id`, `listings.status` (Listings module) — listing-media owner FK; status drives stream-endpoint authorization.
- **DAT-003** `kyc_documents.id`, `kyc_verifications.decided_at` (KYC module) — KYC document linkage; retention anchor.

### Technology Platform Dependencies
- **PLT-001** PostgreSQL 15+ — required for advisory-lock two-arg form, partitioned tables, UPSERT semantics used in rate limiter.
- **PLT-002** S3-compatible object store with presigned POST policy support and server-side COPY API.

### Compliance Dependencies
- **COM-001** ЦК України ст. 257 — 3-year limitation period anchors KYC document retention (delegated to KYC module per REQ-012).
- **COM-002** ЗУ "Про захист персональних даних" — KYC document destruction at retention boundary; bypass of soft-delete grace ensures prompt deletion.
- **COM-003** KYC SEC-009 — KYC bucket access logs retained 1 year.

## 9. Examples & Edge Cases

### 9.1 Confirm idempotency under network retry

```
T+0    Client → POST /uploads/confirm {media_id: X}
T+0.1  Server: HEAD ok; UPDATE status='awaiting_scan'; enqueue job J1.
T+0.5  Client: TCP timeout; retries.
T+0.6  Server → POST /uploads/confirm {media_id: X}
T+0.7  Server: status is already 'awaiting_scan' → return 200 with current status; DO NOT enqueue J2.
```

### 9.2 ClamAV degraded recovery

```
T+0       Confirm enqueues scan job for media M.
T+5s      Worker dequeues, calls ClamAV; daemon down. Set scan_error, scan_attempts=1, scan_error_at=T+5s.
T+5min    Reconciliation sweep: scan_error_at < now()-5min → re-enqueue, scan_attempts unchanged until next worker pickup.
T+5min+1s Worker dequeues; ClamAV still down. scan_attempts=2, scan_error_at=T+5min+1s.
T+10min   Reconciliation sweep re-enqueues.
T+10min+1s ClamAV recovered. Scan clean. Worker promotes to 'ready'.
```

If retries exhaust before recovery: `status='scan_error_permanent'`, `media.scan_error_permanent` outbox event emitted.

### 9.3 Phantom-insert protection on gallery cap

```sql
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtext('listing_media'),
  hashtext(lower($listing_id::text))
);
SELECT COUNT(*) INTO v
  FROM listing_media lm JOIN media_objects mo ON mo.id = lm.media_id
  WHERE lm.listing_id = $listing_id AND mo.purpose = 'listing_gallery';
IF v >= 10 THEN
  RAISE EXCEPTION 'gallery_limit_exceeded' USING ERRCODE = 'P0001';
END IF;
INSERT INTO listing_media (listing_id, media_id, display_order)
VALUES ($listing_id, $media_id, $position);
COMMIT;
```

Two concurrent transactions on the same listing serialize on the advisory lock; only one observes the count and inserts.

### 9.4 KYC retention bypass-grace

```
2026-05-06  Provider P uploaded KYC document M; admin approved (decided_at=2026-05-06).
            KYC handler: UPDATE media_objects SET expires_at='2029-05-06' WHERE id=M.
2029-05-06  Daily KYC retention sweep:
            UPDATE media_objects
              SET deleted_at=now(), hard_deleted_at=now()
              WHERE purpose='kyc_document' AND expires_at <= now() AND hard_deleted_at IS NULL
              RETURNING id, bucket_alias, storage_key;
            For each row: S3 DELETE from kyc-private; emit media.deleted.
            Document is gone within 24 hours of the retention boundary, NOT 7 days later.
```

### 9.5 Cross-purpose owner FK violation

```sql
-- A row with purpose='kyc_document' but no kyc_document_id: REJECTED.
INSERT INTO media_objects (id, owner_user_id, purpose, storage_key, bucket_alias, mime_type, byte_size)
VALUES (gen_random_uuid(), '...', 'kyc_document', '...', 'kyc-private', 'image/jpeg', 1024);
-- ERROR: chk_purpose_fk_kyc

-- A row with two owner FKs: REJECTED.
INSERT INTO media_objects (id, owner_user_id, listing_id, purpose, storage_key, bucket_alias, mime_type, byte_size)
VALUES (gen_random_uuid(), '...', '...', 'listing_cover', '...', 'public-media', 'image/jpeg', 1024);
-- ERROR: chk_exactly_one_owner
```

## 10. Validation Criteria

- All AC-001 through AC-015 pass in CI.
- Migration applies cleanly against a fresh PostgreSQL 15 instance and against a database where the legacy `listing_media` (file_key) DDL exists (the migration must transform or replace it).
- Static security scan: no response handler interpolates `storage_key`, `bucket_alias`, or any S3 URL into 4xx/5xx response bodies.
- Static schema check: `media_objects.purpose` enum values exactly match the set declared in CON-003; no orphan values.
- Load test: `GET /media/{id}/stream` for `listing_cover` sustains 100 RPS at p95 < 50 ms (without CDN); CDN-fronted variant sustains 1000 RPS at p95 < 20 ms.
- Compliance check: KYC retention sweep test against a row with `expires_at = now() - 1 hour` deletes both the DB-row markers and the S3 object in the same daily run, with no 7-day intermediate state.

## 11. Related Specifications / Further Reading

- [`spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — JWT/refresh token model used to authorize all media endpoints.
- [`spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — KYC submission flow; consumes `kyc.document_ready`, owns `expires_at` writes for `kyc_document` purpose, defines `decided_at` retention anchor (§4.11), provides REQ-013 streaming-proxy mandate honored here, defines SEC-009 1-year KYC access-log retention.
- [`spec-architecture-listings.md`](./spec-architecture-listings.md) — **§4.2 `listing_media` DDL is superseded by §4.2 of this spec.** Listings spec retains a one-line pointer to this module; the `file_key TEXT` / `size_bytes` columns are replaced by `media_id UUID FK`. **Coordinator follow-up action:** edit `/spec/spec-architecture-listings.md` §4.2 to replace the DDL block with `-- Superseded. See spec-architecture-media-pipeline.md §4.2.`
- [`spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — future `deal_attachment` purpose (currently out of scope) will integrate here when the Deal-attachments module is specified.
