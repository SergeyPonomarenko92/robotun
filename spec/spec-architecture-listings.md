---
title: Listings — Provider Service Listings (BIZ-002)
version: 1.0
date_created: 2026-05-06
last_updated: 2026-05-06
owner: Platform / Marketplace Team
tags: [architecture, listings, marketplace, search, moderation]
---

# Introduction

This specification defines the Listings module of the Robotun freelance marketplace: the lifecycle, data model, REST API, search, moderation, and cross-module reactions for Provider service listings. A listing is a Provider-published service offering that Clients browse and use to initiate Deals (Module 3). The `deals.listing_id` FK is already reserved with `ON DELETE SET NULL` in Module 3.

The spec is the synthesis of an `architect` × `critic` orchestration loop: 22+ final DECISIONs across 3 architect rounds and 2 critic rounds, with all 20 flagged risks (15 R1 + 5 R2-introduced) resolved or formally accepted as residual.

## 1. Purpose & Scope

**In scope**

- Listing lifecycle state machine: `draft → in_review → active | paused | archived` (with terminal `archived`).
- Schema: `listings`, `listing_media`, `listing_audit_events` (partitioned), `listing_reports`, `listing_appeals`, `listing_snapshots`, `listing_bulk_jobs`, `provider_listing_caps`, `geo_regions`, `geo_cities`, `geo_city_redirects`.
- Pricing model: discriminated columns (`pricing_type ∈ {fixed, hourly, range, starting_from, discuss}` + amount fields).
- Location model: KOATUU-keyed reference tables; service type (`on_site|remote|both`) + service radius. NO PostGIS at MVP.
- Full-text search via PostgreSQL `tsvector` + GIN with `fastupdate=off`. Dictionary fallback (`ukrainian` → `simple`).
- REST API: provider self-service, public search (cursor-paginated), admin/moderator queue, abuse reports.
- Tiered moderation: trusted providers auto-publish; new providers go through admin pre-review.
- Listing → Deal contract: snapshot copy at deal creation; optional price-change check.
- Cross-module reactions to `provider.suspended`, `provider.unsuspended`, `provider.role_revoked`, `provider.kyc_revoked`, `category.archived`, `category.approved`.
- Multi-cause auto-pause via `auto_paused_reasons TEXT[]`.
- Per-provider caps and report rate limits.
- GDPR-aligned retention (snapshots 3 years per ЦК ст. 257; audit events 24-month partition retention; media scheduled deletion).

**Out of scope**

- Media upload pipeline implementation (CDN, transcoding, multi-part PUT) — owned by `spec-infrastructure-media-pipeline.md` (future).
- Feed ranking algorithm — owned by `spec-design-feed-algorithm.md` (future).
- Paid promotion / featured placement.
- Multi-currency support (UAH only per CON-003).
- Listing analytics / view counts.
- Multi-milestone listings (single-stage only at v1).
- Consumer-side "Request" listings (umbrella REQ-005) — separate spec.
- Geocoding pipeline / PostGIS spatial search.
- Notification delivery — owned by Notifications module (consumes outbox events).
- KOATUU import runbook detail — `spec-data-geo-reference.md` (future).
- `platform_settings` table DDL — infrastructure spec.
- `listing_appeals` admin UI / queue priority algorithm.

**Audience:** backend engineers, platform/data engineers, security reviewers, QA, AI code-generation agents producing DDL and service code.

## 2. Definitions

| Term | Definition |
|------|------------|
| Listing | A Provider-published service offering, single row in `listings`. |
| Provider | User with the `provider` role per Module 1. |
| Trusted Provider | Provider who satisfies trusted criteria at publish time (KYC-approved or 3+ distinct-client completed deals at ≥100 UAH). Recomputed every publish; never cached. |
| KOATUU | Класифікатор об'єктів адміністративно-територіального устрою України — Ukrainian administrative-territorial classifier. 10-digit codes used as natural keys for `geo_regions` / `geo_cities`. |
| Snapshot | Row in `listing_snapshots` capturing listing fields at deal-creation time, used as dispute-resolution artifact. |
| Auto-pause | System-imposed pause with one or more reasons in `auto_paused_reasons TEXT[]`. |
| Qualifying report | A report whose reporter satisfies `(kyc_approved OR ≥1 completed deal OR account_age ≥ 7 days)` at report time. Only qualifying reports count toward the auto-pause threshold. |
| Subtree expansion | Recursive CTE (cached in Redis 60s TTL) that resolves a category_id filter to all descendant category IDs for tree-aware search. |
| FTS | Full-text search via PostgreSQL `tsvector` (Ukrainian dictionary, fallback to `simple`). |
| ЦК ст. 257 | Civil Code of Ukraine, Article 257 — 3-year general statute of limitations cited as legal basis for snapshot retention. |
| BIZ-002 | This module's identifier in the umbrella spec taxonomy. |

## 3. Requirements, Constraints & Guidelines

### Functional Requirements

- **REQ-001**: A Provider SHALL create a listing via `POST /listings` (status=`draft`).
- **REQ-002**: A Provider SHALL publish a draft via `POST /listings/{id}/publish`. If trusted, transition to `active`; otherwise transition to `in_review`.
- **REQ-003**: An Admin/Moderator SHALL approve or reject a listing in `in_review` via `POST /admin/listings/{id}/{approve|reject}` (SEC-006 re-read required).
- **REQ-004**: A Provider SHALL pause an active listing via `POST /listings/{id}/pause` and republish via `POST /listings/{id}/publish`.
- **REQ-005**: A Provider SHALL archive a listing via `POST /listings/{id}/archive` (terminal). Listings SHALL NEVER be hard-deleted; a `BEFORE DELETE` trigger blocks any `DELETE` statement.
- **REQ-006**: An authenticated Client SHALL report a listing via `POST /listings/{id}/reports`. Reports SHALL be rate-limited.
- **REQ-007**: A Provider SHALL appeal a `report_threshold` auto-pause via `POST /listings/{id}/appeal-pause`. Only one open appeal per listing.
- **REQ-008**: The public `GET /listings` endpoint SHALL return only `status='active'` listings, cursor-paginated on `(published_at DESC, id)`. Filters: category (subtree-aware), price range, region/city, FTS query, sort.
- **REQ-009**: A Provider's `GET /listings/me` SHALL return all statuses (including drafts), cursor-paginated on `(created_at DESC, id)`.
- **REQ-010**: When a Client creates a deal from a listing, the system SHALL insert a `listing_snapshots` row in the same transaction as `deals` (REQ-001 of Module 3). The snapshot SHALL copy `title`, `description`, `pricing_type`, `price_amount`, `price_amount_max`, `currency`, `service_type`, `category_id`, `provider_id`.
- **REQ-011**: `POST /deals` SHALL accept an optional `expected_listing_price_kopecks` field; if present and differing from `listings.price_amount` at deal-creation time, the deal SHALL be rejected with 409 `listing_price_changed`.
- **REQ-012**: The system SHALL enforce per-provider caps: 50 active listings, 20 drafts, 10 listings created per day. Caps SHALL be tracked in `provider_listing_caps` with `SELECT FOR UPDATE` on row before mutation.
- **REQ-013**: Auto-pause SHALL fire when 5 distinct **qualifying** reports exist on a listing. Threshold SHALL be configurable in `platform_settings`.
- **REQ-014**: Drafts SHALL be auto-archived if no provider-initiated `listing_audit_events` row exists in the last 90 days. System events SHALL NOT reset the inactivity clock.
- **REQ-015**: The system SHALL emit outbox events for all state transitions (per §4.7).
- **REQ-016**: The system SHALL consume `provider.suspended`, `provider.unsuspended`, `provider.role_revoked`, `provider.kyc_revoked`, `category.archived`, `category.approved` events and react per §4.6.
- **REQ-017**: `provider.role_revoked` SHALL trigger an async batch job (`listing_bulk_jobs`) that archives all listings for that provider in batches of 10, each batch under `SET LOCAL statement_timeout='30s'`.

### Security Requirements

- **SEC-001**: Every admin/moderator listing mutation (`/approve`, `/reject`, `/admin/listings/{id}/{archive|pause}`, `/admin/listings/reports/{id}/resolve`) SHALL execute the SEC-006 admin-role re-read against `user_roles` JOIN `users`. JWT-claim-only acceptance is non-conformant.
- **SEC-002**: `POST /listings/{id}/reports` SHALL be rate-limited via Redis to 5 reports per user per 24 h AND 2 reports per user per provider per 24 h. 429 `report_rate_limited` returned on exceed.
- **SEC-003**: Auto-pause threshold SHALL count only **qualifying** reports (reporter has `kyc_approved=true` OR `completed_deals_count≥1` OR `account_age_days≥7` at the time of report submission).
- **SEC-004**: Trusted-provider check SHALL be recomputed on every publish under `SELECT FOR SHARE` on `provider_profiles`, never cached. The check SHALL exclude `kyc_status='rejected'` (which by KYC §4.6.3 mapping covers both `rejected` and `expired` KYC verifications).
- **SEC-005**: `listing_audit_events` SHALL be append-only via DB GRANT (only INSERT, SELECT — no UPDATE, no DELETE granted to application role). Partitions are dropped only by retention maintenance with elevated privilege.

### Constraints

- **CON-001**: Listings are NEVER hard-deleted. Archival is terminal. Enforced by `BEFORE DELETE` trigger on `listings`.
- **CON-002**: All money is stored as integer kopecks (`BIGINT`). All timestamps `TIMESTAMPTZ` UTC.
- **CON-003**: Currency is `UAH` only when present; nullable for `pricing_type='discuss'`. CHECK enforces consistency.
- **CON-004**: `listings.provider_id` is NULLABLE only when `status='archived'`. CHECK constraint enforces this; FK `ON DELETE SET NULL` to `users(id)`.
- **CON-005**: Category tree depth ≤ 3 (Module 2 CON-001). Subtree CTE expansion at most 3 levels.
- **CON-006**: KYC is NOT a precondition for listing creation or deal initiation (CLAUDE.md established decision; KYC at payout only).
- **CON-007**: `pricing_type='discuss'` listings have NULL `price_amount` and NULL `currency`. The `expected_listing_price_kopecks` check on deal creation is skipped for such listings.
- **CON-008**: Per-provider caps: 50 active, 20 drafts, 10 created per day. Configurable in `platform_settings`.
- **CON-009**: `auto_paused_reasons TEXT[]` allowed values: `report_threshold | provider_suspended | provider_kyc_revoked | category_archived`. Enforced by CHECK.
- **CON-010**: Bulk-archive job batch size = 10. Per-batch transaction MUST set `SET LOCAL statement_timeout='30s'`. UPDATE order within a batch: status='archived' first, then provider_id=NULL (CHECK constraint requires this order).
- **CON-011**: `listing_audit_events` is monthly-partitioned with 24-month retention.
- **CON-012**: Snapshot retention: `MAX(deal.decided_at, deal.resolved_at, deal.created_at) + 3 years`. After: PII-purge job nullifies `provider_id`, sets `purged_pii_at`. Title/description/pricing retained as non-PII dispute artifacts.
- **CON-013**: KOATUU import is upsert by `koatuu_code` (NOT truncate-and-reload). Retired codes mapped via `geo_city_redirects`.

### Guidelines

- **GUD-001**: PostgreSQL 'ukrainian' tsvector dictionary should be installed in production. If absent, the migration falls back to 'simple' and records the mode in `platform_settings`. Operator must be alerted via `listing_fts_dictionary_mode` Prometheus gauge.
- **GUD-002**: Subtree cache hit rate `category:subtree:*` should be monitored; sustained low hit rate indicates cache invalidation is too aggressive.
- **GUD-003**: Bulk-archive job progress should be visible in `listing_bulk_jobs` for operational monitoring; long-running jobs (>30 min) should fire a P3 alert.
- **GUD-004**: The 5-qualifying-report auto-pause threshold is configurable. Operators should tune based on observed false-flag rate; lower for high-trust phases, raise during launch.

### Patterns

- **PAT-001**: Optimistic locking — every state-mutating UPDATE includes `WHERE id=$id AND version=$v AND status=$expected`. (Reused from Module 3 PAT-001.)
- **PAT-002**: Idempotent timer pattern — sweep UPDATEs include the timer condition (`auto_complete_after`-style predicate or status guard); zero rows = silent no-op. (Reused from Module 3 PAT-002.)
- **PAT-003**: SELECT FOR SHARE on cross-module read at decision time — used at publish to read `provider_profiles.kyc_status` while preventing race with KYC revocation.
- **PAT-004**: Multi-cause flag array — `auto_paused_reasons TEXT[]` allows simultaneous pause causes; idempotent append via CASE; clear via `array_remove`.
- **PAT-005**: Async batch job with status table — long-running cascade operations use `listing_bulk_jobs` for progress tracking + idempotent retry.
- **PAT-006**: Sargable date-range predicate — `created_at >= CURRENT_DATE::timestamptz AND created_at < CURRENT_DATE::timestamptz + interval '1 day'` instead of `created_at::date = CURRENT_DATE`.

## 4. Interfaces & Data Contracts

### 4.1 Schema — `listings`

```sql
CREATE TABLE listings (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id          UUID         REFERENCES users(id) ON DELETE SET NULL,
  category_id          UUID         NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,

  title                VARCHAR(120) NOT NULL CHECK (char_length(title) BETWEEN 5 AND 120),
  description          TEXT         NOT NULL CHECK (char_length(description) BETWEEN 20 AND 5000),

  status               TEXT         NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','in_review','active','paused','archived')),

  -- Pricing
  pricing_type         TEXT         NOT NULL
                         CHECK (pricing_type IN ('fixed','hourly','range','starting_from','discuss')),
  price_amount         BIGINT       CHECK (price_amount IS NULL OR price_amount > 0),
  price_amount_max     BIGINT       CHECK (price_amount_max IS NULL OR price_amount_max > price_amount),
  currency             CHAR(3),

  -- Location
  service_type         TEXT         NOT NULL DEFAULT 'both'
                         CHECK (service_type IN ('on_site','remote','both')),
  location_city_id     INT          REFERENCES geo_cities(id) ON DELETE SET NULL,
  location_region_id   INT          REFERENCES geo_regions(id) ON DELETE SET NULL,
  service_radius_km    SMALLINT     CHECK (service_radius_km IS NULL OR service_radius_km > 0),

  -- Moderation / pause
  rejection_reason     TEXT,
  auto_paused_at       TIMESTAMPTZ,
  auto_paused_reasons  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  appeal_count         INT          NOT NULL DEFAULT 0,

  -- Concurrency
  version              INTEGER      NOT NULL DEFAULT 1,

  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published_at         TIMESTAMPTZ,
  archived_at          TIMESTAMPTZ,

  -- FTS (dictionary baked at migration time)
  fts_vector           TSVECTOR
                         GENERATED ALWAYS AS (to_tsvector('ukrainian',
                           coalesce(title,'') || ' ' || coalesce(description,''))) STORED,

  CONSTRAINT chk_provider_id_archived CHECK (provider_id IS NOT NULL OR status = 'archived'),
  CONSTRAINT chk_currency_consistent CHECK (
    (pricing_type = 'discuss' AND currency IS NULL)
    OR (pricing_type != 'discuss' AND currency = 'UAH')
  ),
  CONSTRAINT chk_price_required CHECK (
    (pricing_type IN ('fixed','hourly','starting_from') AND price_amount IS NOT NULL)
    OR (pricing_type = 'range' AND price_amount IS NOT NULL AND price_amount_max IS NOT NULL)
    OR (pricing_type = 'discuss')
  ),
  CONSTRAINT chk_auto_paused_reasons CHECK (
    auto_paused_reasons <@ ARRAY['report_threshold','provider_suspended','provider_kyc_revoked','category_archived']::TEXT[]
  )
);

-- Indexes
CREATE INDEX idx_listings_active_cursor
  ON listings (published_at DESC, id DESC)
  WHERE status = 'active';

CREATE INDEX idx_listings_provider_cursor
  ON listings (provider_id, created_at DESC, id DESC);

CREATE INDEX idx_listings_provider_status
  ON listings (provider_id, status, created_at DESC);

CREATE INDEX idx_listings_provider_created
  ON listings (provider_id, created_at);

CREATE INDEX idx_listings_search_active
  ON listings (category_id, status, published_at DESC)
  WHERE status = 'active';

CREATE INDEX idx_listings_price
  ON listings (price_amount, status)
  WHERE status = 'active' AND price_amount IS NOT NULL;

CREATE INDEX idx_listings_location
  ON listings (location_region_id, location_city_id, status)
  WHERE status = 'active';

CREATE INDEX idx_listings_fts
  ON listings USING GIN (fts_vector)
  WITH (fastupdate = off);

CREATE INDEX idx_listings_auto_paused_reasons
  ON listings USING GIN (auto_paused_reasons)
  WHERE status = 'paused';

-- Triggers
CREATE TRIGGER set_listing_updated_at
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE OR REPLACE FUNCTION trg_listing_category_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('draft','in_review','active','paused')
     AND NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND status='active') THEN
    RAISE EXCEPTION 'category_not_active' USING ERRCODE = 'P0004';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listing_category_active_check
  BEFORE INSERT OR UPDATE OF category_id, status ON listings
  FOR EACH ROW EXECUTE FUNCTION trg_listing_category_active();

CREATE OR REPLACE FUNCTION trg_deny_listing_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'listing_delete_forbidden' USING ERRCODE = 'P0007';
END;
$$;
CREATE TRIGGER deny_listing_delete
  BEFORE DELETE ON listings
  FOR EACH ROW EXECUTE FUNCTION trg_deny_listing_delete();
```

### 4.2 Schema — supporting tables

```sql
-- listing_media: SUPERSEDED. See spec-architecture-media-pipeline.md §4.2 for the
-- canonical definition (FK to media_objects; role derived from media_objects.purpose;
-- single-cover trigger). The previous DDL (file_key TEXT, size_bytes, status) is retired.

-- listing_audit_events (partitioned monthly)
CREATE TABLE listing_audit_events (
  id           BIGSERIAL,
  listing_id   UUID         NOT NULL,
  actor_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  actor_role   TEXT         NOT NULL CHECK (actor_role IN ('provider','client','admin','moderator','system')),
  event_type   TEXT         NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- Monthly partitions; 24-month retention drop.
CREATE INDEX idx_lae_listing_id_created ON listing_audit_events (listing_id, created_at DESC);

-- listing_reports
CREATE TABLE listing_reports (
  id                                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                               UUID         NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_id                              UUID         NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reason                                   TEXT         NOT NULL
                                             CHECK (reason IN ('spam','fraud','illegal_content','misleading','duplicate','other')),
  description                              TEXT         CHECK (char_length(description) <= 1000),
  status                                   TEXT         NOT NULL DEFAULT 'pending'
                                             CHECK (status IN ('pending','reviewed','dismissed')),
  reviewed_by                              UUID         REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                              TIMESTAMPTZ,
  reporter_kyc_approved_at_report_time     BOOLEAN      NOT NULL DEFAULT false,
  reporter_completed_deals_at_report_time  INT          NOT NULL DEFAULT 0,
  reporter_account_age_days_at_report_time INT          NOT NULL DEFAULT 0,
  qualifying                               BOOLEAN      GENERATED ALWAYS AS (
                                             reporter_kyc_approved_at_report_time = true
                                             OR reporter_completed_deals_at_report_time >= 1
                                             OR reporter_account_age_days_at_report_time >= 7
                                           ) STORED,
  created_at                               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (listing_id, reporter_id)
);
CREATE INDEX idx_listing_reports_pending ON listing_reports (listing_id, status) WHERE status = 'pending';
CREATE INDEX idx_listing_reports_queue   ON listing_reports (created_at) WHERE status = 'pending';

-- listing_appeals (one open appeal per listing)
CREATE TABLE listing_appeals (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   UUID         NOT NULL REFERENCES listings(id),
  provider_id  UUID         NOT NULL REFERENCES users(id),
  filed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID         REFERENCES users(id),
  resolution   TEXT         CHECK (resolution IN ('reinstated','upheld')),
  admin_note   TEXT
);
CREATE UNIQUE INDEX idx_listing_appeals_open ON listing_appeals (listing_id) WHERE resolved_at IS NULL;

-- listing_snapshots (deal-creation copy)
CREATE TABLE listing_snapshots (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID         REFERENCES listings(id) ON DELETE SET NULL,
  deal_id           UUID         NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  snapshot_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  title             VARCHAR(120) NOT NULL,
  description       TEXT         NOT NULL,
  pricing_type      TEXT         NOT NULL,
  price_amount      BIGINT,
  price_amount_max  BIGINT,
  currency          CHAR(3),
  service_type      TEXT         NOT NULL,
  category_id       UUID,
  provider_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
  purged_pii_at     TIMESTAMPTZ
);
CREATE INDEX idx_snapshots_deal    ON listing_snapshots (deal_id);
CREATE INDEX idx_snapshots_listing ON listing_snapshots (listing_id) WHERE listing_id IS NOT NULL;

-- listing_bulk_jobs (cascade async tracking)
CREATE TABLE listing_bulk_jobs (
  job_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type      TEXT         NOT NULL CHECK (job_type IN ('archive_provider_listings')),
  target_id     UUID         NOT NULL,
  triggered_by  TEXT         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed')),
  processed     INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_bulk_jobs_target ON listing_bulk_jobs (target_id, status);

-- provider_listing_caps (denormalized counters)
CREATE TABLE provider_listing_caps (
  provider_id    UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_count   INT     NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  draft_count    INT     NOT NULL DEFAULT 0 CHECK (draft_count >= 0),
  created_today  INT     NOT NULL DEFAULT 0 CHECK (created_today >= 0),
  today_date     DATE    NOT NULL DEFAULT CURRENT_DATE
);

-- Geo reference tables (KOATUU)
CREATE TABLE geo_regions (
  id          SERIAL    PRIMARY KEY,
  koatuu_code CHAR(10)  UNIQUE NOT NULL,
  name        TEXT      NOT NULL,
  slug        TEXT      NOT NULL UNIQUE
);

CREATE TABLE geo_cities (
  id          SERIAL    PRIMARY KEY,
  koatuu_code CHAR(10)  UNIQUE NOT NULL,
  region_id   INT       NOT NULL REFERENCES geo_regions(id),
  name        TEXT      NOT NULL,
  slug        TEXT      NOT NULL,
  population  INT,
  UNIQUE (region_id, slug)
);
CREATE INDEX idx_geo_cities_region ON geo_cities (region_id);

CREATE TABLE geo_city_redirects (
  old_city_id    INT          PRIMARY KEY REFERENCES geo_cities(id),
  new_city_id    INT          NOT NULL REFERENCES geo_cities(id),
  redirected_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

### 4.3 State machine

```
             (Provider POST /listings)
                       │
                       ▼
                ┌────────────┐
            ┌───│   draft    │───┐
            │   └─────┬──────┘   │
   (publish, trusted) │ (publish, non-trusted)
            ▼          ▼
    ┌────────────┐  ┌────────────┐
    │   active   │◄─│  in_review │  (admin /approve)
    └────┬───────┘  └────┬───────┘
         │               │ (admin /reject)
         │               └──► draft
         │
   (provider /pause)
   (system events: report_threshold, provider_suspended,
                   provider_kyc_revoked, category_archived
                   → append to auto_paused_reasons)
         │
         ▼
    ┌────────────┐
    │   paused   │── (provider /publish, IF cardinality(reasons)=0)
    └────┬───────┘    → active OR in_review (recheck trusted)
         │
   (provider /archive | system role_revoked | draft auto-expiry 90d)
         │
         ▼
    ┌────────────┐
    │  archived  │  (terminal; provider_id may be NULL)
    └────────────┘
```

**Transition table:**

| From | To | Actor | Guard | Side-effects |
|------|-----|-------|-------|--------------|
| (none) | draft | provider | caps not exceeded; category active | Insert; outbox `listing.created` |
| draft | active | provider | trusted; required fields complete | published_at=now(); outbox `listing.published` |
| draft | in_review | provider | non-trusted; required fields complete | outbox `listing.submitted_for_review` |
| in_review | active | admin/moderator | SEC-006 OK | published_at=now(); outbox `listing.published` |
| in_review | draft | admin/moderator | SEC-006 OK; rejection_reason required | outbox `listing.rejected` |
| active | paused | provider | status='active' | outbox `listing.paused`; audit `paused_by_provider` |
| active | paused | system | report threshold / provider_suspended / provider_kyc_revoked / category_archived | append to `auto_paused_reasons`; outbox `listing.auto_paused` |
| paused | active | provider | trusted; cardinality(auto_paused_reasons)=0 | outbox `listing.published` |
| paused | in_review | provider | non-trusted; cardinality(auto_paused_reasons)=0 | outbox `listing.submitted_for_review` |
| any non-archived | archived | provider | (no guard) | outbox `listing.archived` |
| any non-archived | archived | system | role_revoked OR draft 90-day inactivity | outbox `listing.archived` (or `listing.draft_expired`) |
| any non-archived | archived | admin | SEC-006 OK | outbox `listing.force_archived` |

Terminal: `archived`. No transitions out of `archived`. `provider_id` may be NULL only when `status='archived'`.

### 4.4 Trusted-provider definition

Recomputed on every publish under `SELECT FOR SHARE` on `provider_profiles`:

```
trusted = TRUE iff one of:
  (A) kyc_status = 'approved' AND last_kyc_decided_at IS NOT NULL
  (B) kyc_status != 'rejected'
      AND COUNT(DISTINCT client_id WHERE
            deals.status='completed'
            AND deals.agreed_price >= 10000  -- 100 UAH in kopecks
            AND provider_id = $pid) >= 3
```

Path B excludes `kyc_status='rejected'` only, since the KYC denormalization mapping (KYC §4.6.3) collapses both `rejected` and `expired` KYC verifications to `provider_profiles.kyc_status='rejected'`.

### 4.5 REST API

All endpoints prefixed `/api/v1`. `application/json`. Bearer JWT for authenticated endpoints.

#### 4.5.1 Provider endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/listings` | Create draft (caps enforced) |
| GET | `/listings/me` | Own listings, filter by status, cursor on `(created_at DESC, id)` |
| GET | `/listings/{id}` | Detail (own only if non-active) |
| PATCH | `/listings/{id}` | Edit (rules per §4.5.5) |
| POST | `/listings/{id}/publish` | draft|paused → active or in_review (per trusted) |
| POST | `/listings/{id}/pause` | active → paused |
| POST | `/listings/{id}/archive` | any → archived (terminal) |
| POST | `/listings/{id}/media` | Add media (max 10 total, max 10 MB each) |
| DELETE | `/listings/{id}/media/{media_id}` | Remove media |
| POST | `/listings/{id}/appeal-pause` | Appeal `report_threshold` auto-pause |

#### 4.5.2 Public / Client endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/listings` | Public search (active only); cursor on `(published_at DESC, id)` |
| GET | `/listings/{id}` | Public detail (active only for anonymous) |
| POST | `/listings/{id}/reports` | File abuse report (authenticated; rate-limited) |

#### 4.5.3 Admin / Moderator endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/listings` | All listings, any status |
| GET | `/admin/listings/reports` | Pending report queue |
| POST | `/admin/listings/{id}/approve` | in_review → active |
| POST | `/admin/listings/{id}/reject` | in_review → draft, rejection_reason required |
| POST | `/admin/listings/{id}/pause` | Force-pause with reason (admin) |
| POST | `/admin/listings/{id}/archive` | Force-archive |
| POST | `/admin/listings/reports/{report_id}/resolve` | Mark report `reviewed` or `dismissed` |
| POST | `/admin/listings/{id}/appeals/{appeal_id}/resolve` | Resolve appeal (`reinstated` or `upheld`) |

#### 4.5.4 Sample requests

`POST /listings`:
```json
{
  "category_id": "uuid",
  "title": "Ремонт пральних машин — виїзд по Харкову",
  "description": "Виїзна діагностика та ремонт пральних машин усіх марок ...",
  "pricing_type": "range",
  "price_amount": 50000,
  "price_amount_max": 150000,
  "service_type": "on_site",
  "location_city_id": 42,
  "location_region_id": 7,
  "service_radius_km": 20
}
```

`GET /listings`:
```
GET /api/v1/listings
  ?category_id=<uuid>
  &region_id=7&city_id=42
  &min_price=50000&max_price=200000
  &q=ремонт+пральних
  &sort=newest|price_asc|price_desc|relevance
  &limit=20
  &cursor=<base64>
```

Response:
```json
{
  "items": [ /* listing summaries */ ],
  "next_cursor": "eyJ0cyI6IjIwMjYtMDUtMDZUMTA6MDQ6NTlaIiwiaWQiOiJ1dWlkIn0=",
  "has_more": true
}
```

`POST /listings/{id}/publish`:
```json
{ "version": 1 }
```
Response (trusted):
```json
{ "id": "uuid", "status": "active", "version": 2, "published_at": "2026-05-06T10:05:00Z" }
```
Response (non-trusted):
```json
{ "id": "uuid", "status": "in_review", "version": 2 }
```
Response (paused, system reasons present):
```json
HTTP 422
{ "error": "republish_blocked_by_system_pause", "auto_paused_reasons": ["provider_suspended"] }
```

`POST /listings/{id}/reports`:
```json
{ "reason": "spam", "description": "duplicate of listing X" }
```
Response:
```json
HTTP 201
{ "report_id": "uuid", "qualifying": true }
```
Or:
```json
HTTP 429
{ "error": "report_rate_limited", "retry_after_seconds": 86400 }
```

`POST /listings/{id}/appeal-pause`:
```json
{ "explanation": "Reports were submitted by competing provider" }
```
Response:
```json
HTTP 202
{ "appeal_id": "uuid" }
```

### 4.6 Cross-module reactions (consumed events)

| Event | Source | Effect |
|-------|--------|--------|
| `provider.suspended` | Auth | Active listings → paused; append `provider_suspended` to `auto_paused_reasons` |
| `provider.unsuspended` | Auth | `array_remove('provider_suspended', auto_paused_reasons)`. Listings remain paused; provider must manually republish |
| `provider.role_revoked` | Auth | Async batch job (`listing_bulk_jobs`); batch=10, `SET LOCAL statement_timeout='30s'`; per batch UPDATE sets status='archived' THEN provider_id=NULL (CHECK order) |
| `provider.kyc_revoked` | KYC | Active listings → paused; append `provider_kyc_revoked` to `auto_paused_reasons` |
| `category.archived` | Categories | Active listings under that category → paused; append `category_archived`; provider must reassign category before republish (trigger blocks) |
| `category.approved` | Categories | Invalidate Redis subtree cache `category:subtree:{id}` (and ancestor chain from event payload) |

Auth's 90-day hard-purge job:
1. Emits `provider.role_revoked`.
2. Listings consumes; bulk-archive job runs in batches; emits `listing.bulk_archive_complete`.
3. Auth purge job polls for `listing.bulk_archive_complete` event OR `listing_bulk_jobs.status='completed'`.
4. Auth then deletes `users` row. FK `listings.provider_id ON DELETE SET NULL` is the backstop.

### 4.7 Outbox event registry

| Event | Trigger |
|-------|---------|
| `listing.created` | POST /listings |
| `listing.submitted_for_review` | publish, non-trusted |
| `listing.published` | publish, trusted (or admin approve) |
| `listing.rejected` | admin reject |
| `listing.paused` | provider /pause |
| `listing.auto_paused` | system pause cause appended |
| `listing.archived` | provider /archive |
| `listing.force_archived` | admin /archive |
| `listing.edited` | PATCH /listings/{id} |
| `listing.reported` | POST /reports |
| `listing.draft_expired` | 90-day draft auto-archive sweep |
| `listing.appeal_filed` | POST /appeal-pause |
| `listing.bulk_archived` | bulk job batch commit |
| `listing.bulk_archive_complete` | bulk job final |
| `listing.category_archived` | consumed `category.archived` reaction (per affected listing) |

### 4.8 FTS dictionary fallback

Migration DO block:
```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_ts_dict WHERE dictname = 'ukrainian') THEN
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES ('listing_fts_dictionary_mode', '"ukrainian"', now())
    ON CONFLICT (key) DO UPDATE SET value = '"ukrainian"', updated_at = now();
  ELSE
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES ('listing_fts_dictionary_mode', '"simple"', now())
    ON CONFLICT (key) DO UPDATE SET value = '"simple"', updated_at = now();
  END IF;
END $$;
```

If `simple` is recorded, the `fts_vector` GENERATED expression in §4.1 is rewritten by the migration to `to_tsvector('simple', ...)`.

Prometheus gauge `listing_fts_dictionary_mode{value=...}` emitted by application health-check.

### 4.9 Subtree cache

```
Redis key:    category:subtree:{category_id}
Value:        JSON array of UUIDs (self + descendants)
TTL:          60 s
Invalidation: on `category.archived` / `category.approved` events.
              Event payload MUST include the full ancestor chain (Module 2 contract).
              Listings consumer DELs `category:subtree:{id}` for each ancestor + self.
Fallback:     SET LOCAL statement_timeout='100ms'; CTE on miss/Redis-down.
              503 + Retry-After: 5 on CTE timeout.
```

### 4.10 Rate limits

| Endpoint | Limit | Storage | Response on exceed |
|----------|-------|---------|--------------------|
| `POST /listings/{id}/reports` | 5 reports / user / 24 h | Redis | 429 `report_rate_limited` |
| `POST /listings/{id}/reports` | 2 reports / user / provider / 24 h | Redis | 429 `report_rate_limited` |
| `POST /listings` | 10 / day per provider | `provider_listing_caps.created_today` | 429 `daily_creation_limit` |

### 4.11 Sweep jobs

| Job | Cadence | Action |
|-----|---------|--------|
| Draft auto-archive | daily | drafts with no provider-initiated `listing_audit_events` row in 90 d → status='archived'; outbox `listing.draft_expired` |
| Media scheduled-delete | daily | `listing_media WHERE scheduled_delete_at <= now()` → DELETE S3 object → DELETE row |
| Media orphan detection | daily | `status='pending_confirmation' AND created_at < now() - 1 h` → set `scheduled_delete_at = now() + 7 d` |
| Snapshot PII purge | daily | `MAX(deal.decided_at, deal.resolved_at, deal.created_at) + 3 y < now() AND purged_pii_at IS NULL` → set `provider_id=NULL`, set `purged_pii_at=now()` |
| `listing_audit_events` partition retention | monthly | DROP partitions older than 24 months |
| Caps reconciliation | nightly | Recompute `active_count`, `draft_count` from `listings` |
| Bulk-archive job | event-triggered | Batch=10, `SET LOCAL statement_timeout='30s'`, idempotent |

Draft expiry sweep query:

```sql
UPDATE listings l SET status='archived', archived_at=now()
WHERE l.status='draft'
  AND NOT EXISTS (
    SELECT 1 FROM listing_audit_events lae
    WHERE lae.listing_id = l.id
      AND lae.actor_role = 'provider'
      AND lae.event_type IN (
        'listing.created','listing.edited','listing.submitted_for_review',
        'listing.published','listing.paused_by_provider'
      )
      AND lae.created_at > now() - interval '90 days'
  )
RETURNING l.id;
```

System events (`actor_role IN ('admin','moderator','system')`) explicitly do NOT reset the inactivity clock.

### 4.12 Caps daily-recompute query

```sql
UPDATE provider_listing_caps
SET today_date    = CURRENT_DATE,
    created_today = (
      SELECT COUNT(*) FROM listings
      WHERE provider_id = $provider_id
        AND created_at >= CURRENT_DATE::timestamptz
        AND created_at <  CURRENT_DATE::timestamptz + interval '1 day'
    )
WHERE provider_id = $provider_id
  AND today_date < CURRENT_DATE;
```

Sargable predicate (uses `idx_listings_provider_created`).

## 5. Acceptance Criteria

- **AC-001**: Given a Provider with valid JWT, When POST `/listings` with valid body and caps not exceeded, Then a `listings` row is inserted with `status='draft'`, `version=1`, and an outbox `listing.created` is enqueued in the same transaction.
- **AC-002**: Given a Provider whose `provider_listing_caps.draft_count = 20`, When POST `/listings`, Then 429 `draft_cap_exceeded` is returned and no row is inserted.
- **AC-003**: Given a Provider whose `created_today >= 10`, When POST `/listings`, Then 429 `daily_creation_limit` is returned. The cap check uses sargable range predicate `created_at >= CURRENT_DATE::timestamptz AND created_at < CURRENT_DATE::timestamptz + interval '1 day'`.
- **AC-004**: Given a draft listing and a trusted provider (path A or path B), When POST `/listings/{id}/publish` with valid version, Then `status` transitions to `active`, `published_at=now()`, and `listing.published` is in outbox. The trusted check uses `SELECT FOR SHARE` on `provider_profiles`.
- **AC-005**: Given a draft listing and a non-trusted provider, When POST `/listings/{id}/publish`, Then `status` transitions to `in_review` and `listing.submitted_for_review` is in outbox.
- **AC-006**: Given a Provider with `kyc_status='approved'` who later has KYC revoked (mapped to `kyc_status='rejected'`) AND has 5 completed deals from 5 distinct clients with `agreed_price >= 10000`, When publishing, Then `trusted=FALSE` (path B excludes `kyc_status='rejected'`) → transitions to `in_review`.
- **AC-007**: Given an active listing, When the system consumes `provider.kyc_revoked` for that provider, Then the listing transitions to `paused` AND `auto_paused_reasons` array contains `provider_kyc_revoked`.
- **AC-008**: Given a paused listing with `auto_paused_reasons = ['provider_suspended','report_threshold']`, When provider POSTs `/publish`, Then 422 `republish_blocked_by_system_pause` is returned. When provider POSTs `/appeal-pause` and admin upholds (clears `report_threshold`), then `auto_paused_reasons = ['provider_suspended']` (still non-empty), and republish remains blocked.
- **AC-009**: Given 4 prior qualifying reports on a listing, When a 5th qualifying report INSERT fires, Then the BEFORE INSERT trigger transitions listing to `paused`, appends `report_threshold` to `auto_paused_reasons`, and emits `listing.auto_paused`.
- **AC-010**: Given a non-qualifying reporter (account_age=2 days, no completed deals, kyc not approved), When 5 such reports exist, Then the listing is NOT auto-paused (`SUM(qualifying::int) = 0 < 5`).
- **AC-011**: Given a reporter who already filed 5 reports in the last 24 h, When POST /listings/{id}/reports, Then 429 `report_rate_limited` is returned and no row inserted.
- **AC-012**: Given the public `GET /listings` endpoint, Then only `status='active'` rows are returned, ordered by `published_at DESC, id DESC`, paginated by keyset cursor encoding `(published_at, id)`.
- **AC-013**: Given the provider `GET /listings/me` endpoint, Then all statuses are returned (including drafts with NULL `published_at`), ordered by `created_at DESC, id DESC`. Public-cursor passed to provider endpoint returns 400 `invalid_cursor_shape`.
- **AC-014**: Given a category-tree filter at level 1, When `GET /listings?category_id=$id`, Then the subtree is resolved via Redis `category:subtree:{id}` cache (60s TTL) or recursive CTE fallback (`SET LOCAL statement_timeout='100ms'`); 503 returned on CTE timeout.
- **AC-015**: Given a Client POSTs /deals from a listing with `expected_listing_price_kopecks=50000` and the listing's current `price_amount=70000`, Then 409 `listing_price_changed` returned with `current_price_kopecks=70000`. Skipped for `pricing_type='discuss'`.
- **AC-016**: Given a deal is created from a listing, Then a `listing_snapshots` row is inserted in the same transaction copying title/description/pricing/category/provider.
- **AC-017**: Given a deal completed >3 years ago (per `MAX(decided_at, resolved_at, created_at)`), When the snapshot PII purge sweep runs, Then `provider_id=NULL`, `purged_pii_at=now()`. Title/description/pricing retained.
- **AC-018**: Given `provider.role_revoked` event, Then a `listing_bulk_jobs` row is inserted with `status='running'`; batch job processes 10 listings per transaction with `SET LOCAL statement_timeout='30s'`; each batch UPDATE sets `status='archived'` THEN `provider_id=NULL` (CHECK constraint requires this order).
- **AC-019**: Given a draft listing with no provider-initiated audit event in the last 90 days, When the daily draft-expiry sweep runs, Then `status='archived'`, `archived_at=now()`, and `listing.draft_expired` event is emitted. System events on the draft (e.g., `listing.auto_paused`) do NOT reset the 90-day clock.
- **AC-020**: Given a `pricing_type='discuss'` listing, Then `currency IS NULL` and `price_amount IS NULL`. The CHECK constraint `chk_currency_consistent` rejects any combination otherwise.
- **AC-021**: Given a listing with `status='archived'`, Then `provider_id IS NULL` is allowed by the CHECK `chk_provider_id_archived`. For any other status, `provider_id IS NOT NULL` is enforced.
- **AC-022**: Given any DELETE statement against `listings`, Then the `BEFORE DELETE` trigger raises `listing_delete_forbidden` (P0007).
- **AC-023**: Given KOATUU quarterly import marks a city as retired with successor, Then the import upserts by `koatuu_code`, inserts a `geo_city_redirects` row, AND bulk-updates `listings.location_city_id` from old → new in the same transaction.

## 6. Test Automation Strategy

- **Test Levels**: Unit (trusted definition logic, FTS vector composition, qualifying-report computation), Integration (REST endpoints + DB + Redis), End-to-End (publish flow with trusted/non-trusted, deal-creation snapshot, bulk-archive cascade).
- **Frameworks**: language-agnostic at spec level. Test harness must support: PostgreSQL 15 testcontainer (with `ukrainian` dictionary OR fallback path tested), Redis testcontainer, S3-compatible store (MinIO), JWT minting (RS256), Prometheus metric scrape assertions.
- **Test Data Management**: per-test schema migrations to fresh DB. Seed `users`, `provider_profiles`, `categories`, `geo_cities`, `geo_regions`. KOATUU import dry-run on test fixtures.
- **CI/CD Integration**: full integration suite on every PR. Migration test asserts FTS dictionary fallback path (`simple` mode) executes successfully when `pg_ts_dict` lacks `ukrainian`.
- **Coverage Requirements**: ≥ 90 % line coverage on Listings service module; 100 % branch coverage on state-transition switch and trusted-definition logic.
- **Performance Testing**: loadgen — 100 concurrent `GET /listings` searches against a 100k-listing dataset; assert p99 < 200 ms. 50 concurrent `POST /reports` against a single listing; assert auto-pause trigger fires once at 5th qualifying report (no double-fire). Bulk-archive job test with 200 listings: assert all archived in batches of 10 with each batch transaction completing within 30 s.
- **Race tests** (deterministic): publish-vs-KYC-revoke race using DB advisory locks (AC-006, AC-007); concurrent report INSERTs for threshold trigger (AC-009); bulk-archive provider_id NULL with concurrent listing CREATE attempt (AC-018).

## 7. Rationale & Context

### Tiered moderation (REQ-002, AC-004/AC-005)

Pure auto-publish allows day-zero spam campaigns; pure pre-moderation creates an admin bottleneck that kills Provider activation. Tiered model (trusted = KYC-approved OR 3+ distinct-client paid deals) is the standard industry pattern. Trusted threshold is intentionally low (one of two paths, threshold=3 deals at ≥100 UAH) to convert legitimate Providers quickly while still blocking sockpuppet farms.

### Trusted definition with distinct-client + min-price + KYC exclusion (SEC-004, AC-006)

Round-1 definition `KYC OR completed_deals_count >= 3` was gameable: two colluding accounts could complete 3 micro-deals to bypass moderation forever. R2 added: distinct `client_id` (≥3), min `agreed_price >= 10000` kopecks (100 UAH), and KYC revocation removes trusted status. R3 corrected the KYC enum reference: KYC-spec mapping (§4.6.3) collapses both `rejected` and `expired` into `provider_profiles.kyc_status='rejected'`, so the exclusion list reduces to `kyc_status != 'rejected'`. `SELECT FOR SHARE` on `provider_profiles` during publish prevents the race where KYC is revoked concurrently.

### Multi-cause auto-pause (PAT-004, AC-008)

A single `auto_paused_reason TEXT` cannot represent simultaneous causes (e.g., report threshold + provider suspension). An appeal that clears `report_threshold` would inadvertently allow republish while suspension persists. Array-based model with per-cause append/remove + `cardinality=0` republish guard prevents cross-cause interference.

### Snapshot copy not reference (REQ-010, AC-016, AC-017)

Pure FK to `listings` breaks if the listing is archived or materially edited; existing deals lose their dispute evidence. Snapshot copies title/description/pricing/category/provider at deal-creation time. Storage cost is negligible (~500 bytes/deal). Retention window: `MAX(decided_at, resolved_at, created_at) + 3 years` per ЦК ст. 257; PII (provider_id) nullified after window. Title/description retained as non-PII dispute audit (consistent with KYC `kyc_review_events` pattern).

### `listings.provider_id` NULLABLE only when archived (CON-004, AC-021)

GDPR hard-purge requires `provider_id` to be releasable from `users` rows. Making the column outright NULLABLE without a guard would allow inconsistent active listings with no owner. CHECK `(provider_id IS NOT NULL OR status='archived')` enforces the invariant: only archived listings may have NULL `provider_id`. Bulk-archive job sets status='archived' BEFORE provider_id=NULL within each batch transaction; CHECK is order-sensitive.

### Cursor split (REQ-008/REQ-009, AC-013)

`published_at` is NULL for drafts, breaking keyset comparison. Public endpoint returns only active listings (always non-NULL `published_at`), so `(published_at DESC, id)` is safe. Provider endpoint returns mixed statuses; uses `(created_at DESC, id)` instead. Two separate cursor encodings prevent accidental cross-endpoint reuse (400 on wrong shape).

### tsvector with `fastupdate=off` (CON-005 of search; AC-014)

`fastupdate=on` (default) creates a pending list flushed only on overflow or scheduled `gin_clean_pending_list` — search results lag writes by seconds to minutes. `fastupdate=off` adds slight write-time cost in exchange for predictable read freshness, appropriate for a moderate-write/heavy-read table. Elasticsearch deferred to v2 via existing outbox events.

### KOATUU upsert by code (CON-013, AC-023)

Truncate-and-reload on quarterly KOATUU refresh would FK-violate active listings pointing to retired city rows. Upsert by `koatuu_code` natural key preserves surrogate INT PKs that listings hold. Retired-code mapping via `geo_city_redirects` allows bulk-update of listings to successor cities in the same import transaction.

### Auto-pause threshold counts only qualifying reports (SEC-003, AC-009/AC-010)

Sockpuppet farms with 5 freshly-created accounts can trivially flood reports. The qualifying gate (`kyc_approved OR ≥1 completed deal OR account_age ≥ 7 days`) imposes friction without burdening legitimate users. Combined with API rate limits (5 reports/user/24h global, 2 per provider), false-flag attacks become costly.

### Report rate limits (SEC-002)

UNIQUE(listing_id, reporter_id) at DB level prevents one user from reporting twice. API rate limits via Redis prevent the same user from filing reports across many listings or against the same provider. Both layers needed: DB UNIQUE is structural; Redis rate limits are temporal.

### Async bulk-archive on role-revoked (REQ-017, CON-010, AC-018)

A Provider with the cap-maximum (50 active + 20 drafts = 70 listings) revoked role would cause a 70-row UPDATE + 70 outbox + 70 audit rows in one transaction — risk of statement_timeout, lock contention. Async batch (10/tx, 30s timeout, idempotent, status table) is resumable on crash. Each batch sets status='archived' first, then provider_id=NULL, satisfying the CHECK constraint order.

### KMS / encryption NOT in this module

Listings carry no PII beyond `provider_id` (which is itself an FK). No biometric or document data. No envelope encryption needed. (Distinct from KYC module.)

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001**: Categories module (Module 2) — `categories.id` FK source; consumes `category.archived` / `category.approved` events.
- **EXT-002**: Users / Auth module (Module 1) — `users.id` FK source; consumes `provider.suspended`, `provider.unsuspended`, `provider.role_revoked` events.
- **EXT-003**: KYC module (Module 4) — `provider_profiles.kyc_status` read at publish; consumes `provider.kyc_revoked` event.
- **EXT-004**: Deal Workflow module (Module 3) — `deals` FK target via `listing_snapshots.deal_id`; produces `listing_snapshots` row in same tx as `deals` insert. Consumes `expected_listing_price_kopecks` from POST /deals body.
- **EXT-005**: Notifications module (future) — consumes all `listing.*` outbox events for user/admin notifications.
- **EXT-006**: Feed module (future) — consumes `listing.published`, `listing.archived`, `listing.edited` for feed indexing.
- **EXT-007**: Object storage (S3-compatible) — stores `listing_media` files; lifecycle deletion on `scheduled_delete_at`.

### Third-Party Services
- **SVC-001**: Redis — rate limit counters, subtree cache. SLA: <5 ms p99 latency.

### Infrastructure Dependencies
- **INF-001**: PostgreSQL 15+ — partitioning, partial indexes, GIN with `fastupdate=off`, GENERATED columns, array operators.
- **INF-002**: `outbox_events` table (Module 2) — at-least-once delivery of `listing.*` events.
- **INF-003**: `platform_settings` key-value store — runtime configurable thresholds (auto-pause threshold, FTS dictionary mode).
- **INF-004**: Prometheus + Alertmanager — metrics (`listing_fts_dictionary_mode`, `listing_subtree_cache_miss_total`, bulk-job progress).
- **INF-005**: Object storage with bucket lifecycle policy — for `scheduled_delete_at` enforcement on `listing_media`.

### Data Dependencies
- **DAT-001**: KOATUU register — quarterly import of Ukrainian administrative-territorial classifier; canonical source for `geo_regions` and `geo_cities` natural keys (`koatuu_code`).
- **DAT-002**: PostgreSQL `ukrainian` text-search dictionary (recommended); fallback to `simple`.

### Technology Platform Dependencies
- **PLT-001**: PostgreSQL 15+ — for partition syntax, expression-indexed GENERATED columns, array CHECK with `<@`.

### Compliance Dependencies
- **COM-001**: ЗУ Про захист персональних даних (Ukrainian Personal Data Protection Law) — proportionality of snapshot retention; PII purge after retention window.
- **COM-002**: ЦК України ст. 257 — 3-year general statute of limitations cited as legal basis for snapshot retention.

## 9. Examples & Edge Cases

### 9.1 Trusted publish (path A: KYC-approved)

```
T0   Provider (kyc_status='approved') POST /listings → status=draft
T1   POST /listings/{id}/publish
     SELECT FOR SHARE on provider_profiles → kyc_status='approved'
     trusted = TRUE (path A)
     UPDATE listings SET status='active', published_at=now()
     INSERT outbox_events ('listing.published', ...)
     COMMIT
T2   Public GET /listings shows the listing.
```

### 9.2 Non-trusted publish (path B fails, no KYC, only 2 distinct clients)

```
T0   Provider (kyc_status='none', 2 completed deals from 2 distinct clients ≥100 UAH)
T1   POST /publish
     trusted = FALSE (path A: kyc != approved; path B: distinct clients < 3)
     UPDATE status='in_review'
     INSERT outbox_events ('listing.submitted_for_review', ...)
T2   Admin reviews → POST /admin/listings/{id}/approve (SEC-006)
     UPDATE status='active', published_at=now()
     INSERT outbox_events ('listing.published', ...)
```

### 9.3 KYC revocation on trusted-via-deals provider

```
T0   Provider (kyc_status='none', 5 completed deals from 5 distinct clients) ≥ trusted via path B
T1   Listing in active status
T2   Admin revokes KYC (KYC module sets provider_profiles.kyc_status='rejected'
     via expired→rejected mapping per KYC §4.6.3); emits provider.kyc_revoked
T3   Listings consumes provider.kyc_revoked:
     UPDATE listings SET status='paused',
            auto_paused_reasons = array_append(auto_paused_reasons, 'provider_kyc_revoked')
     WHERE provider_id=$pid AND status='active' AND NOT ('provider_kyc_revoked' = ANY(auto_paused_reasons))
T4   Provider POST /publish:
     SELECT FOR SHARE → kyc_status='rejected' → trusted=FALSE for both paths (path B excludes 'rejected')
     422 republish_blocked_by_system_pause (auto_paused_reasons non-empty)
```

### 9.4 Multi-cause auto-pause + appeal

```
T0   Active listing, auto_paused_reasons = []
T1   5 qualifying reports → trigger auto-pause: auto_paused_reasons = ['report_threshold']
T2   Provider suspended → consumer appends: auto_paused_reasons = ['report_threshold','provider_suspended']
T3   Provider POST /appeal-pause → listing_appeals row, listing.appeal_filed event
T4   Admin upholds appeal NOT (resolves with reinstated):
     array_remove('report_threshold') → auto_paused_reasons = ['provider_suspended']
T5   Provider POST /publish:
     cardinality(['provider_suspended']) = 1 ≠ 0 → 422 republish_blocked_by_system_pause
T6   Admin unsuspends provider → consumer removes 'provider_suspended':
     auto_paused_reasons = []
T7   Provider POST /publish → cardinality=0 → trusted check → status='active'
```

### 9.5 Hard-purge cascade

```
T0   Provider has 50 active + 20 drafts. Auth schedules hard-purge (90-day window).
T1   Auth emits provider.role_revoked.
T2   Listings consumer creates listing_bulk_jobs row (status='running').
T3   Bulk job processes batch 1 (10 listings):
     BEGIN
       SET LOCAL statement_timeout='30s';
       UPDATE listings SET status='archived', archived_at=now()
         WHERE id = ANY($batch) AND status != 'archived';
       UPDATE listings SET provider_id=NULL
         WHERE id = ANY($batch) AND status='archived';   -- CHECK satisfied
       INSERT outbox 'listing.bulk_archived' (batch_seq, count);
       UPDATE listing_bulk_jobs SET processed=processed+10;
     COMMIT
T4   Repeat until no rows remain.
T5   Final batch sets listing_bulk_jobs.status='completed', emits listing.bulk_archive_complete.
T6   Auth purge polls; sees completion; deletes users row.
     FK listings.provider_id ON DELETE SET NULL is no-op (already NULL).
```

### 9.6 Deal price-change race

```
T0   Listing price_amount=50000.
T1   Client GET /listings/{id} → sees 50000.
T2   Provider PATCH /listings/{id} → price_amount=70000 (allowed mid-active).
T3   Client POST /deals:
     {
       "listing_id": "...",
       "agreed_price": 50000,
       "expected_listing_price_kopecks": 50000
     }
     Inside transaction: SELECT FOR SHARE on listings → current price=70000
     50000 != 70000 → 409 listing_price_changed
     {"current_price_kopecks": 70000, "current_pricing_type": "fixed"}
T4   Client retries with expected=70000 (or chooses different listing).
```

### 9.7 Draft auto-archive

```
T-90d  Provider creates draft. listing_audit_events row (actor='provider', event='listing.created').
T-30d  System auto-pauses (e.g., category-archived event) — actor_role='system', NOT counted.
T0     Daily sweep runs. Provider has not edited or published since T-90d.
       NOT EXISTS provider-initiated event in last 90d → archive.
       INSERT outbox 'listing.draft_expired'.
```

### 9.8 Pricing types

| pricing_type | price_amount | price_amount_max | currency | Valid? |
|--------------|--------------|------------------|----------|--------|
| fixed | 100000 | NULL | UAH | ✅ |
| hourly | 30000 | NULL | UAH | ✅ |
| range | 50000 | 150000 | UAH | ✅ |
| starting_from | 80000 | NULL | UAH | ✅ |
| discuss | NULL | NULL | NULL | ✅ |
| fixed | NULL | NULL | UAH | ❌ chk_price_required |
| range | 50000 | 30000 | UAH | ❌ price_amount_max > price_amount |
| discuss | NULL | NULL | UAH | ❌ chk_currency_consistent |
| fixed | 50000 | NULL | NULL | ❌ chk_currency_consistent |

## 10. Validation Criteria

A conforming implementation MUST satisfy:

1. All AC-001 through AC-023.
2. DDL matches §4.1–§4.2 byte-for-byte after normalization.
3. State machine in §4.3 is the authoritative legal-transition list; transitions outside it return 422 `invalid_listing_transition`.
4. Trusted definition in §4.4 is implemented exactly: KYC path A (`kyc_status='approved' AND last_kyc_decided_at IS NOT NULL`) OR distinct-client deals path B (`kyc_status != 'rejected'` AND ≥3 distinct `client_id` with `agreed_price >= 10000` and `status='completed'`).
5. Public and provider cursor strategies are split per §4.5; each endpoint rejects a cursor of the other shape with 400.
6. `listings.provider_id` is NULLABLE only when `status='archived'` (CHECK enforced).
7. `auto_paused_reasons TEXT[]` enforces enum CHECK; multi-cause pause and appeal flow per AC-008.
8. Trigger inventory: `trg_listing_category_active`, `trg_deny_listing_delete`, BEFORE INSERT trigger on `listing_reports` for auto-pause threshold, `trg_set_updated_at`.
9. KOATUU import follows upsert-by-`koatuu_code` contract (§4.2 and CON-013).
10. `listing_audit_events` is partitioned monthly with 24-month retention.
11. FTS migration includes the dictionary-availability DO block (§4.8).
12. `expected_listing_price_kopecks` cross-module contract honored on `POST /deals` (Module 3 dependency).

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-marketplace-social-platform.md`](./spec-architecture-marketplace-social-platform.md) — umbrella; CON-002 (no payments at MVP), COM-001 (ЗУ Про захист персональних даних), BIZ-002 (this module).
- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — Module 1; `provider_profiles`, `users.mfa_enabled`, SEC-006 admin re-read pattern, 90-day hard-purge job.
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — Module 2; `categories.id` FK target; `outbox_events` table DDL; `category.archived`/`category.approved` events with **ancestor chain in payload** (cache invalidation contract).
- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — Module 3; `deals.listing_id ON DELETE SET NULL` already reserved; `expected_listing_price_kopecks` field on POST /deals validated against `listings.price_amount`.
- [`spec/spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — Module 4; `provider_profiles.kyc_status` enum mapping (§4.6.3 — `expired` collapsed to `rejected`); CON-006 (KYC NOT at deal/listing time); new `provider.kyc_revoked` outbox event consumed by Listings.
- Future: `spec/spec-data-geo-reference.md` — KOATUU import runbook detail.
- Future: `spec/spec-infrastructure-media-pipeline.md` — `listing_media` upload/CDN/transcoding details.
- Future: `spec/spec-design-feed-algorithm.md` — `listing.published` ranking in personalized feed.
- Future: `spec/spec-architecture-reviews.md` — review display on listing pages.
- Цивільний кодекс України, ст. 257 — 3-year statute of limitations cited as snapshot retention basis.
- Закон України Про захист персональних даних — proportionality of retention.
