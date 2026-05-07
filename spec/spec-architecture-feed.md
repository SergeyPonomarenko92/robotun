---
title: Feed — Discovery, Ranking, Promotions, Personalization
version: 1.0
date_created: 2026-05-07
last_updated: 2026-05-07
owner: Platform / Backend
tags: [architecture, feed, discovery, ranking, search, promotions]
---

# Introduction

This module specifies the **Feed**: the primary discovery surface where Clients browse and search Provider listings. It defines query semantics, filter and facet model, ranking signals and formula, score storage and refresh, anonymous-page caching, promoted placements, personalization, anti-abuse controls, and integration contracts with Listings, Reviews, Categories, and Auth.

The module owns `feed_rank_scores`, `feed_promotions`, `feed_user_state`, `feed_abuse_events`, and the Redis namespaces `feed:anon:*` and `cat:subtree:*`. It introduces no schema changes to existing modules' canonical tables.

## 1. Purpose & Scope

Define the data model, ranking formula, query plans, cache strategy, promotions surface, personalization model, anti-abuse posture, and API surface for the Robotun discovery feed.

**In scope.**
- Cursor-paginated organic feed with filters (category subtree, location, price, rating, KYC, service type).
- Free-text search via existing Listings `fts_vector` GIN index with `ts_rank_cd` runtime relevance.
- A canonical, deterministic ranking formula (`feed_base_score`) used by both write and read paths.
- Pre-computed `feed_rank_scores` populated event-driven on `listing.published` and refreshed by a 60-second sweep on invalidation.
- Anonymous-page Redis cache with generation-counter invalidation and single-flight rebuild.
- Admin-managed promoted placements isolated from organic results (no double-impressions).
- Per-user personalization: location stickiness, recently-viewed ring buffer, saved searches.
- Rate limiting and audit-log-only abuse tracking.
- Defense-in-depth visibility join on `users.status` so suspended providers' listings disappear at read time.
- Total-estimate count (capped) for empty-result UX.

**Out of scope.**
- Saved-search email digests, push notifications.
- ML / collaborative-filtering recommendation; A/B testing infrastructure.
- Self-serve ad bidding marketplace; CPM/CPC auction mechanics.
- Geospatial radius search (PostGIS deferred per Listings spec).
- Per-facet counts (only `total_estimate` is returned).
- Listing impression / view analytics — owned by a future analytics module.
- Multi-currency (UAH only, inherited from Listings).
- Meilisearch/Elasticsearch (deferred until FTS recall is empirically inadequate).
- Runtime weight tuning UI; weights live in `platform_settings` keys plus code constants.

**Audience.** Backend engineers, platform engineers, search/ranking team, moderation tooling team, frontend consumers of the feed API.

**Assumptions.** PostgreSQL 15+ with `pgcrypto`, `pg_trgm` already present (per Listings); existing `outbox_events` infrastructure; Redis 7 with Lua; the Listings, Reviews, Categories, Auth, KYC modules are deployed per their finalized specs; the existing `idx_listings_active_cursor`, `idx_listings_fts`, and `listings.fts_vector` are in place.

## 2. Definitions

| Term | Definition |
|---|---|
| Feed | The cursor-paginated list of `status='active'` listings returned by `GET /feed`, optionally filtered, optionally q-searched, ranked by `feed_base_score` (+ `ts_rank_cd` on q path). |
| Canonical formula | `feed_base_score(...)` — the single IMMUTABLE SQL function whose output sums to 1.0 and is the source of truth for both write and read ranking paths. |
| `feed_rank_scores` | Per-listing precomputed score row; PK `listing_id`, refreshed event-driven and via a 60-second sweep on invalidation. |
| Generation counter | Redis monotonically-incrementing integer at `feed:anon:gen`; embedded in anon-cache keys so old entries become unreachable on `INCR`. |
| Single-flight lock | Redis `SET NX EX 5` lock pattern (per Categories GUD-001) used to prevent thundering herd on cache miss; pollers wait 200 ms × 10 then fall through to a direct DB read without rewriting cache. |
| Promoted slot | A `feed_promotions` row scheduling a listing into a paid placement; up to 2 slots per page, dedup'd from the organic candidate set, labeled `sponsored=true` with disclosure `Реклама`. |
| Defense-in-depth visibility | The read-time JOIN `users u WHERE u.status='active'` applied to every feed query in addition to `listings.status='active'`, ensuring suspended-provider listings are hidden even if state-machine consumers lag. |
| Total estimate | Capped result count (`SELECT COUNT(*) FROM feed_candidates LIMIT 1001`) returned in the response so the client UI can surface filter-removal affordances on empty pages. |

## 3. Requirements, Constraints & Guidelines

### Functional requirements

- **REQ-001** `GET /feed` SHALL return a cursor-paginated list of `status='active'` listings with optional filters (`category_id`, `region_id`, `city_id`, `price_min`, `price_max`, `pricing_type`, `service_type`, `min_rating`, `kyc_only`).
- **REQ-002** Cursor pagination SHALL use the keyset `(feed_rank_scores.score DESC, listings.id DESC)` for the non-query path. The cursor token SHALL be an opaque base64url-encoded JSON `{score, listing_id, v}` HMAC-SHA256-signed with a server secret.
- **REQ-003** `GET /feed?q=...` SHALL filter via `WHERE listings.fts_vector @@ plainto_tsquery('uk', :q)` using the existing `idx_listings_fts` GIN index, and SHALL order by `0.80 * frs.score + 0.20 * ts_rank_cd(fts_vector, query, 32)` at runtime.
- **REQ-004** Pagination depth SHALL be capped: 20 pages on the non-query path (`platform_settings.feed_max_page_depth`, default 20) and 5 pages on the q path (`platform_settings.feed_max_query_page_depth`, default 5). Requests beyond the cap SHALL return `400 pagination_depth_exceeded`.
- **REQ-005** When `category_id` is provided, the candidate set SHALL include all descendants of the category in the 3-level tree, expanded via a recursive CTE whose result is cached at `cat:subtree:v1:{id}` (Redis, TTL 55 s).
- **REQ-006** Subtree cache rebuilds SHALL be guarded by a single-flight lock at `cat:subtree:lock:{id}` acquired via `SET NX EX 5`; non-acquiring requests SHALL poll the cache key 200 ms × 10 then fall through to a direct DB read without writing the cache.
- **REQ-007** When `city_id` is set, the location predicate SHALL be `(l.location_city_id = :city_id OR l.service_type = 'remote')`. When only `region_id` is set, `(l.location_region_id = :region_id OR l.service_type = 'remote')`. With no location filter, no location predicate is applied.
- **REQ-008** The canonical scoring formula SHALL be encapsulated in `feed_base_score(sig_recency, sig_review_score, sig_deal_count, sig_kyc, sig_profile_complete) RETURNS FLOAT IMMUTABLE` whose body is the weighted sum specified in §4.3 and whose coefficients sum to 1.0.
- **REQ-009** Both the INSERT path (REQ-010) and the read path SHALL use `feed_base_score(...)` exclusively. No path SHALL inline a different weight set.
- **REQ-010** On receipt of the `listing.published` outbox event the feed worker SHALL `INSERT ... ON CONFLICT (listing_id) DO UPDATE` a `feed_rank_scores` row with all signals computed inline at event-handling time. The new row SHALL be visible to feed queries before the next 60-second sweep.
- **REQ-011** A periodic worker SHALL recompute scores for rows where `invalidated_at IS NOT NULL`, every 60 seconds, processing 200 rows per batch with `FOR UPDATE SKIP LOCKED` and re-running on saturation.
- **REQ-012** The feed worker SHALL set `invalidated_at = now()` for the affected listings on receipt of `listing.updated`, `listing.status_changed`, `review.status_changed` (Reviews module emits this on aggregate-changing transitions), and on provider profile updates affecting any signal column.
- **REQ-013** Anonymous `GET /feed*` responses SHALL be cached at `feed:anon:{gen}:{params_hash}` (TTL 30 s), where `gen = INCR-then-GET feed:anon:gen` and `params_hash = SHA-256(canonical_sorted_query_params)`.
- **REQ-014** Cache rebuilds on miss SHALL use the single-flight lock at `feed:anon:lock:{gen}:{params_hash}` (SET NX EX 5; pollers 200 ms × 10; fall through to direct DB without write on lock-holder failure).
- **REQ-015** Authenticated requests SHALL NOT be cached at the page level.
- **REQ-016** On `category.archived`, the feed worker SHALL `INCR feed:anon:gen` AND `DEL cat:subtree:v1:{id}`. On `category.approved`, only `DEL cat:subtree:v1:{parent_chain}` is required.
- **REQ-017** Each feed request whose URL carries `category_id` SHALL verify the category's `status='active'` against an app-tier local cache (TTL 5 s); if archived, the response SHALL be `410 Gone` with body `{"code":"FEED_CATEGORY_ARCHIVED", ...}`.
- **REQ-018** Promotions SHALL be admin-only at v1; `POST /admin/feed/promotions` creates a row, `PATCH` updates status, `DELETE` is via status transition only.
- **REQ-019** A page SHALL contain at most 2 promoted slots; promoted listing IDs SHALL be excluded from the organic CTE (`NOT IN (SELECT listing_id FROM promoted)`).
- **REQ-020** Each promoted card SHALL render with `sponsored: true` and `disclosure_label: 'Реклама'` in the response payload, regardless of locale.
- **REQ-021** `POST /feed/viewed` SHALL append the viewed `listing_id` via `array_prepend` and rely on `trg_recently_viewed_cap` to slice to the last 50 elements atomically.
- **REQ-022** Saved searches SHALL be capped at 10 per user (DB CHECK on `jsonb_array_length(saved_searches) <= 10`).
- **REQ-023** Recently-viewed entries SHALL be used at v1 for ranking exclusion only — they SHALL NOT be a hard filter (a user with all known listings viewed still receives results).
- **REQ-024** Anonymous `GET /feed*` and `GET /feed/search` SHALL be rate-limited to 60 requests per minute per trusted-LB IP. Authenticated SHALL be 120 requests per minute per `user_id`. `POST /feed/viewed` SHALL be 200 per hour per `user_id`.
- **REQ-025** Three rate-limit violations within a rolling 10 minutes SHALL trigger exponential backoff with `Retry-After: 2^n` seconds capped at 300; an event SHALL be appended to `feed_abuse_events`.
- **REQ-026** Each feed candidate query SHALL JOIN `users u ON u.id = l.provider_id WHERE u.status='active'` as defense-in-depth alongside `l.status='active'`.
- **REQ-027** `provider_profiles.kyc_status='approved'` SHALL be a RANKING signal (sig_kyc), NEVER a visibility predicate. Listings from non-KYC-approved providers remain visible per CLAUDE.md established decision.
- **REQ-028** The feed response SHALL include `total_estimate` (capped at 1000) and `total_capped` (boolean) computed via `SELECT COUNT(*) FROM feed_candidates LIMIT 1001`.

### Security requirements

- **SEC-001** Cursor tokens SHALL be HMAC-SHA256-signed with a server-side secret rotated per the platform's standard schedule. An invalid signature SHALL result in `400 invalid_cursor`.
- **SEC-002** The rate-limit fingerprint SHALL be `SHA-256(trusted_lb_ip)`. User-Agent SHALL NOT participate in the fingerprint. Only `X-Forwarded-For` injected by the trusted load balancer is read; client-supplied `X-Forwarded-For` headers from outside the trust boundary SHALL be ignored.
- **SEC-003** Promoted placement creation (`POST /admin/feed/promotions`) SHALL require admin role; the `disclosure_label` SHALL be immutable after activation.
- **SEC-004** `feed_user_state.recently_viewed` and `saved_searches` are personal data; `ON DELETE CASCADE` from `users` SHALL handle GDPR erasure with no special handler required.
- **SEC-005** Admin promotion endpoints SHALL audit-log every state transition with actor `user_id` and prior status to a standard audit table or outbox event, consistent with Listings admin moderation pattern.
- **SEC-006** Feed responses SHALL NOT include unsafe HTML in any free-text field; output SHALL be escaped at render time.
- **SEC-007** A category-archived request received with a URL that the local cache claims is archived SHALL return `410 Gone` with no listing data; this prevents stale cursor pages from leaking results that should not appear after a moderator action.

### Patterns

- **PAT-001** Single canonical scoring formula. Both INSERT and read paths call `feed_base_score(...)` to guarantee stored and runtime scores are commensurable.
- **PAT-002** Stable score-keyset cursor. The cursor encodes the score at the time of the request; pagination depth cap (20 / 5 pages) bounds drift due to mid-session rescores.
- **PAT-003** Generation-counter cache invalidation. `INCR feed:anon:gen` makes all old anonymous-cache entries unreachable atomically without SCAN.
- **PAT-004** Single-flight rebuild. Both `cat:subtree:lock:{id}` and `feed:anon:lock:{gen}:{hash}` use the same `SET NX EX 5` + 200 ms × 10 poll pattern (Categories GUD-001).
- **PAT-005** Defense-in-depth visibility. `users.status='active'` JOIN is applied at read time as a backstop to listings state-machine consumers.
- **PAT-006** Promoted/organic split with NOT IN dedup. Promoted candidates are computed first; organic CTE excludes those IDs to avoid double-impression and disclosure ambiguity.
- **PAT-007** Trigger-enforced ring buffer. `trg_recently_viewed_cap` slices `recently_viewed[1:50]` on every write, regardless of the application path.
- **PAT-008** Trusted-LB-IP fingerprint. Rate limiter reads only the LB-injected client IP; UA is excluded to deny trivial bypass via header rotation.
- **PAT-009** App-tier local cache for category-archived check. 5-second TTL keeps the per-request DB cost negligible while bounding staleness for the 410-Gone path.
- **PAT-010** No PostGIS, no external search engine. PostgreSQL FTS + GIN + recursive CTE on the 3-level category tree are the only data-platform primitives at v1; external systems are deferred until a measured trigger.

### Constraints

- **CON-001** PostgreSQL 15+, Redis 7, existing `outbox_events` infrastructure.
- **CON-002** Cursor token version field `v=1`; future cursor schema changes increment `v` and the server SHALL reject mismatched versions with `400 invalid_cursor`.
- **CON-003** Score weight set is fixed at v1: 0.35 / 0.25 / 0.20 / 0.10 / 0.10 (sum = 1.0). Q-path adds 20 % `sig_text_relevance` by re-weighting the base contribution to 0.80.
- **CON-004** `feed_rank_scores.score NUMERIC(7,4)` (range 0.0000–1.0000 base; promoted-augmented values do not write back to the column — promoted slots are returned as a separate CTE branch).
- **CON-005** Score sweep: 60-second cadence, `LIMIT 200` per batch, immediate re-run on saturation.
- **CON-006** Anon cache TTL: 30 s. Subtree cache TTL: 55 s. App-tier category-archived cache TTL: 5 s.
- **CON-007** Pagination depth: 20 pages on non-q path; 5 pages on q path.
- **CON-008** Promotion slots per page: 2 maximum, configurable via `platform_settings.feed_promoted_slots_per_page` (default 2).
- **CON-009** Recently-viewed cap: 50 (DB trigger).
- **CON-010** Saved searches cap: 10 (DB CHECK).
- **CON-011** Rate limits: 60 req/min/IP anon; 120 req/min/user auth; 200 req/h/user `/feed/viewed`.
- **CON-012** Total estimate cap: 1000 (`SELECT COUNT(*) ... LIMIT 1001`).
- **CON-013** `ts_rank_cd` normalization flag: 32 (divide by mean harmonic distance between extents).

### Guidelines

- **GUD-001** Reuse the Categories GUD-001 single-flight lock pattern verbatim for both feed cache miss paths; do not invent a new locking convention.
- **GUD-002** When the active listings corpus exceeds 10 000 rows AND the median q-path response time exceeds 250 ms p95, evaluate Meilisearch as the FTS backend. Migration SHALL preserve the cursor contract.
- **GUD-003** When promoted placement volume reaches a self-serve threshold, do NOT extend `feed_promotions` with a bidding column set; instead, design a new `ad_auctions` module that writes into `feed_promotions` as a producer.
- **GUD-004** Score weight tuning is a deploy-time change at v1 (code constants). When weight tuning becomes operationally common, migrate weights to `platform_settings` keys and add an admin tuning UI; until then, prefer code-review gating over runtime mutability.
- **GUD-005** A NULL `feed_rank_scores.score` is treated as 0; new listings should not appear with NULL because REQ-010 INSERTs at publish time. If a NULL is observed in production, treat it as a missed publish event and trigger a manual `POST /admin/feed/rank/recompute`.

## 4. Interfaces & Data Contracts

### 4.1 `feed_rank_scores`

```sql
CREATE TABLE feed_rank_scores (
  listing_id              UUID         PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,

  score                   NUMERIC(7,4) NOT NULL DEFAULT 0,

  sig_recency             NUMERIC(7,6) NOT NULL DEFAULT 0,
  sig_review_score        NUMERIC(7,6) NOT NULL DEFAULT 0,
  sig_deal_count          NUMERIC(7,6) NOT NULL DEFAULT 0,
  sig_kyc                 NUMERIC(7,6) NOT NULL DEFAULT 0,
  sig_profile_complete    NUMERIC(7,6) NOT NULL DEFAULT 0,

  computed_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  invalidated_at          TIMESTAMPTZ,

  CONSTRAINT chk_score_range CHECK (score >= 0 AND score <= 1),
  CONSTRAINT chk_signals_range CHECK (
        sig_recency          BETWEEN 0 AND 1
    AND sig_review_score     BETWEEN 0 AND 1
    AND sig_deal_count       BETWEEN 0 AND 1
    AND sig_kyc              BETWEEN 0 AND 1
    AND sig_profile_complete BETWEEN 0 AND 1
  )
);

CREATE INDEX idx_feed_rank_scores_score
  ON feed_rank_scores (score DESC, listing_id DESC);

CREATE INDEX idx_feed_rank_scores_invalidated
  ON feed_rank_scores (invalidated_at)
  WHERE invalidated_at IS NOT NULL;
```

### 4.2 `feed_promotions`

```sql
CREATE TABLE feed_promotions (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          UUID         NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  promoted_by         UUID         NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,

  slot_type           TEXT         NOT NULL CHECK (slot_type IN ('category_top','search_top')),
  target_category_id  UUID         REFERENCES categories(id) ON DELETE SET NULL,

  starts_at           TIMESTAMPTZ  NOT NULL,
  ends_at             TIMESTAMPTZ  NOT NULL,

  budget_kopecks      BIGINT       NOT NULL CHECK (budget_kopecks > 0),
  spent_kopecks       BIGINT       NOT NULL DEFAULT 0 CHECK (spent_kopecks >= 0),

  status              TEXT         NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','active','paused','exhausted','expired','cancelled')),

  disclosure_label    TEXT         NOT NULL DEFAULT 'Реклама',

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_promotion_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_category_top_target
    CHECK (NOT (slot_type = 'category_top' AND target_category_id IS NULL))
);

CREATE INDEX idx_promotions_active
  ON feed_promotions (target_category_id, ends_at)
  WHERE status = 'active';

CREATE INDEX idx_promotions_listing
  ON feed_promotions (listing_id, status);
```

### 4.3 Canonical scoring function

```sql
CREATE OR REPLACE FUNCTION feed_base_score(
  sig_recency           FLOAT,
  sig_review_score      FLOAT,
  sig_deal_count        FLOAT,
  sig_kyc               FLOAT,
  sig_profile_complete  FLOAT
) RETURNS FLOAT
LANGUAGE sql IMMUTABLE AS $$
  SELECT
      0.35 * sig_recency
    + 0.25 * sig_review_score
    + 0.20 * sig_deal_count
    + 0.10 * sig_kyc
    + 0.10 * sig_profile_complete
$$;

-- Signal definitions used by both INSERT path and 60-second sweep:
-- sig_recency           = exp(-0.05 * GREATEST(0, EXTRACT(epoch FROM now() - l.published_at)/86400))
-- sig_review_score      = COALESCE((l.avg_rating - 1) / 4.0, 0)
-- sig_deal_count        = LEAST(provider_completed_deals_count / 50.0, 1)
-- sig_kyc               = CASE WHEN pp.kyc_status = 'approved' THEN 1 ELSE 0 END
-- sig_profile_complete  = CASE WHEN pp.headline IS NOT NULL
--                              AND up.bio IS NOT NULL
--                              AND up.avatar_url IS NOT NULL THEN 1 ELSE 0 END
```

`provider_completed_deals_count` is read from `provider_profiles.completed_deals_count` (Reviews-spec referenced column) at signal-computation time. If the column is unavailable in a particular deployment phase, fall back to a sub-SELECT against `deals WHERE status='completed' AND provider_id = l.provider_id`.

### 4.4 `feed_user_state`

```sql
CREATE TABLE feed_user_state (
  user_id             UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  preferred_region_id INT          REFERENCES geo_regions(id)  ON DELETE SET NULL,
  preferred_city_id   INT          REFERENCES geo_cities(id)   ON DELETE SET NULL,

  recently_viewed     UUID[]       NOT NULL DEFAULT '{}'::uuid[],
  saved_searches      JSONB        NOT NULL DEFAULT '[]'::jsonb,

  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_recently_viewed_cap CHECK (cardinality(recently_viewed) <= 50),
  CONSTRAINT chk_saved_searches_cap  CHECK (jsonb_array_length(saved_searches) <= 10)
);

CREATE OR REPLACE FUNCTION trg_recently_viewed_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.recently_viewed := COALESCE(NEW.recently_viewed, '{}'::uuid[]);
  IF cardinality(NEW.recently_viewed) > 50 THEN
    NEW.recently_viewed := NEW.recently_viewed[1:50];
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_feed_user_state_cap
  BEFORE INSERT OR UPDATE
  ON feed_user_state
  FOR EACH ROW EXECUTE FUNCTION trg_recently_viewed_cap();
```

### 4.5 `feed_abuse_events`

```sql
CREATE TABLE feed_abuse_events (
  id            BIGSERIAL    PRIMARY KEY,
  fingerprint   TEXT         NOT NULL,        -- SHA-256(trusted_lb_ip)
  event_type    TEXT         NOT NULL
                  CHECK (event_type IN ('rate_limited','suspicious_burst','backoff_applied')),
  detail        JSONB,
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_feed_abuse_events_fp
  ON feed_abuse_events (fingerprint, occurred_at DESC);
```

### 4.6 Indexes added to existing tables

```sql
-- Run outside a transaction (CONCURRENTLY).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_avg_rating
  ON listings (avg_rating DESC, id DESC)
  WHERE status = 'active' AND avg_rating IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_service_type_active
  ON listings (service_type, published_at DESC, id DESC)
  WHERE status = 'active';
```

`idx_listings_active_id` (proposed in R1) is dropped from the design as redundant with the existing `idx_listings_active_cursor` and the table primary key; do not create it.

### 4.7 Outbox event registry (Feed module is consumer; emits none of its own at v1)

| Event | Producer | Feed action |
|---|---|---|
| `listing.published` | Listings | INSERT or UPSERT `feed_rank_scores` (REQ-010). |
| `listing.updated` | Listings | Set `invalidated_at = now()` on the listing's row. |
| `listing.status_changed` | Listings | If `to_status='active'` and no row, INSERT; else `invalidated_at = now()`; INCR `feed:anon:gen`. |
| `review.status_changed` | Reviews | Set `invalidated_at = now()` (the Reviews aggregation worker has updated `listings.avg_rating`). |
| `category.archived` | Categories | INCR `feed:anon:gen` AND DEL `cat:subtree:v1:{id}`. |
| `category.approved` | Categories | DEL `cat:subtree:v1:{parent_id}` chain. |

The Feed module emits no outbox events at v1.

### 4.8 REST API

| Method | Path | Auth | Summary |
|---|---|---|---|
| `GET` | `/feed` | optional | Cursor-paginated organic feed |
| `GET` | `/feed/search` | optional | FTS + filter feed |
| `GET` | `/feed/categories/{id}` | optional | Category-scoped feed |
| `POST` | `/feed/viewed` | required | Record a view |
| `GET` | `/feed/saved-searches` | required | List user's saved searches |
| `POST` | `/feed/saved-searches` | required | Save a search |
| `DELETE` | `/feed/saved-searches/{id}` | required | Remove a saved search |
| `GET` | `/admin/feed/promotions` | admin | List promotions |
| `POST` | `/admin/feed/promotions` | admin | Create promotion |
| `PATCH` | `/admin/feed/promotions/{id}` | admin | Update promotion status |
| `POST` | `/admin/feed/rank/recompute` | admin | Force full rank recompute (background job) |

#### `GET /feed`

Request:

```
GET /api/v1/feed
  ?category_id=<uuid>
  &q=<string max=200>
  &price_min=<int kopecks>
  &price_max=<int kopecks>
  &pricing_type=fixed|hourly|range|starting_from|discuss
  &service_type=on_site|remote|both
  &region_id=<int>
  &city_id=<int>
  &min_rating=<float 1.0..5.0>
  &kyc_only=<bool>
  &sort=relevance|newest|price_asc|price_desc|rating
  &cursor=<opaque>
  &limit=<int 1..40, default 20>
```

Response 200:

```json
{
  "data": [
    {
      "id": "uuid",
      "slot": "promoted",
      "sponsored": true,
      "disclosure_label": "Реклама",
      "title": "...",
      "pricing_type": "fixed",
      "price_amount": 150000,
      "currency": "UAH",
      "service_type": "on_site",
      "category": { "id": "uuid", "name": "...", "level": 3, "breadcrumb": ["...","..."] },
      "location": { "region": "Київська область", "city": "Київ" },
      "provider": {
        "id": "uuid",
        "display_name": "Іван М.",
        "kyc_verified": true,
        "avg_rating": 4.87,
        "review_count": 43
      },
      "listing_stats": { "avg_rating": 4.90, "review_count": 51 },
      "cover_image_url": "https://cdn.example.com/...",
      "published_at": "2026-04-10T08:22:00Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJzIjowLjg5LCJpZCI6InV1aWQiLCJ2IjoxfQ.<sig>",
    "has_more": true,
    "limit": 20,
    "mode": "ranked",
    "max_pages": 20
  },
  "total_estimate": 47,
  "total_capped": false,
  "meta": {
    "applied_filters": { "...": "..." },
    "promoted_count": 2
  }
}
```

Error responses:
- `400 invalid_cursor` — bad signature, version mismatch, or malformed token.
- `400 pagination_depth_exceeded` — past the configured cap.
- `410 Gone` `{"code":"FEED_CATEGORY_ARCHIVED"}` — `category_id` references an archived category.
- `429 Too Many Requests` — rate limit; carries `Retry-After`.

#### `POST /feed/viewed`

```http
POST /api/v1/feed/viewed
Authorization: Bearer <jwt>
{ "listing_id": "uuid" }

204 No Content
```

#### `POST /admin/feed/promotions`

```http
POST /api/v1/admin/feed/promotions
{
  "listing_id": "uuid",
  "slot_type": "category_top",
  "target_category_id": "uuid",
  "starts_at": "2026-05-10T00:00:00Z",
  "ends_at": "2026-05-20T00:00:00Z",
  "budget_kopecks": 500000
}

201 Created
{
  "id": "uuid",
  "status": "pending",
  "disclosure_label": "Реклама",
  ...
}
```

### 4.9 Feed candidates CTE (read path, simplified)

```sql
WITH promoted AS (
  SELECT l.id, frs.score
  FROM   feed_promotions p
  JOIN   listings l            ON l.id = p.listing_id
  JOIN   provider_profiles pp  ON pp.user_id = l.provider_id
  JOIN   user_profiles up      ON up.user_id = l.provider_id
  JOIN   users u               ON u.id      = l.provider_id
  JOIN   feed_rank_scores frs  ON frs.listing_id = l.id
  WHERE  l.status = 'active' AND u.status = 'active'
    AND  p.status = 'active'
    AND  p.starts_at <= now() AND p.ends_at > now()
    AND  /* category / location / price filters */
  ORDER BY frs.score DESC, l.id DESC
  LIMIT 2
),
organic AS (
  SELECT l.id, frs.score
  FROM   listings l
  JOIN   provider_profiles pp  ON pp.user_id = l.provider_id
  JOIN   user_profiles up      ON up.user_id = l.provider_id
  JOIN   users u               ON u.id      = l.provider_id
  JOIN   feed_rank_scores frs  ON frs.listing_id = l.id
  WHERE  l.status = 'active' AND u.status = 'active'
    AND  l.id NOT IN (SELECT id FROM promoted)
    AND  /* category / location / price filters */
    AND  (frs.score, l.id) < (:cursor_score, :cursor_id)   -- cursor predicate (omitted on page 1)
  ORDER BY frs.score DESC, l.id DESC
  LIMIT  :limit
)
SELECT 'promoted' AS slot, * FROM promoted
UNION ALL
SELECT 'organic'  AS slot, * FROM organic;
```

The total-estimate query runs against the same CTE without LIMIT/cursor:

```sql
SELECT COUNT(*) FROM (
  SELECT 1 FROM /* same JOINs and WHERE as organic, no cursor predicate */ LIMIT 1001
) c;
```

### 4.10 INSERT path on `listing.published` (REQ-010)

```sql
INSERT INTO feed_rank_scores (
  listing_id, score,
  sig_recency, sig_review_score, sig_deal_count, sig_kyc, sig_profile_complete,
  computed_at
)
SELECT
  l.id,
  feed_base_score(
    exp(-0.05 * GREATEST(0,
      EXTRACT(epoch FROM now() - l.published_at) / 86400.0)),
    COALESCE((l.avg_rating - 1) / 4.0, 0),
    LEAST(COALESCE(pp.completed_deals_count, 0) / 50.0, 1),
    CASE WHEN pp.kyc_status = 'approved' THEN 1 ELSE 0 END,
    CASE WHEN pp.headline IS NOT NULL
              AND up.bio IS NOT NULL
              AND up.avatar_url IS NOT NULL
         THEN 1 ELSE 0 END
  ),
  /* same five signal expressions repeated for storage */
  ...,
  now()
FROM listings l
JOIN provider_profiles pp ON pp.user_id = l.provider_id
JOIN user_profiles up      ON up.user_id = l.provider_id
WHERE l.id = $1
ON CONFLICT (listing_id) DO UPDATE
  SET score = EXCLUDED.score,
      sig_recency = EXCLUDED.sig_recency,
      sig_review_score = EXCLUDED.sig_review_score,
      sig_deal_count = EXCLUDED.sig_deal_count,
      sig_kyc = EXCLUDED.sig_kyc,
      sig_profile_complete = EXCLUDED.sig_profile_complete,
      computed_at = now(),
      invalidated_at = NULL;
```

### 4.11 Reveal sweep (60 seconds)

```sql
WITH due AS (
  SELECT listing_id
  FROM   feed_rank_scores
  WHERE  invalidated_at IS NOT NULL
  ORDER BY invalidated_at
  FOR UPDATE SKIP LOCKED
  LIMIT 200
)
UPDATE feed_rank_scores frs
   SET score                = feed_base_score(...recomputed signals...),
       sig_recency          = ...,
       sig_review_score     = ...,
       sig_deal_count       = ...,
       sig_kyc              = ...,
       sig_profile_complete = ...,
       computed_at          = now(),
       invalidated_at       = NULL
  FROM due
 WHERE frs.listing_id = due.listing_id;
-- Re-run immediately on saturation (200 rows).
```

## 5. Acceptance Criteria

- **AC-001** Given an anonymous request to `GET /feed` with no filters, when the response is cached and a second request arrives within 30 s, then the second request hits the Redis cache (single Redis GET, no DB query).
- **AC-002** Given a category is archived, when the next anonymous `GET /feed` request fires, then `feed:anon:gen` has been INCR'd and the request misses the cache; rebuild is single-flight protected.
- **AC-003** Given a `category_id` filter referencing an archived category, when the request arrives, then the response is `410 Gone` with code `FEED_CATEGORY_ARCHIVED`.
- **AC-004** Given two clients pagination through `GET /feed` simultaneously, when their cursors carry distinct (score, id) tuples, then they each receive disjoint pages and no listing appears on consecutive pages or is skipped between consecutive pages within the depth cap window.
- **AC-005** Given a request beyond page 20 on the non-q path or page 5 on the q path, when the cursor decodes to a depth past the cap, then the response is `400 pagination_depth_exceeded`.
- **AC-006** Given a `q=...` parameter, when the request reaches the read path, then the ORDER BY expression is `0.80 * frs.score + 0.20 * ts_rank_cd(fts_vector, plainto_tsquery('uk', :q), 32)`.
- **AC-007** Given a city filter and a remote-eligible listing, when the candidate CTE runs, then the listing is included via `(l.location_city_id = :city_id OR l.service_type = 'remote')`.
- **AC-008** Given a `listing.published` event arrives, when the consumer commits, then `feed_rank_scores.score` for that listing is non-zero (assuming non-zero signals) and the listing is queryable from the feed before the next 60-second sweep.
- **AC-009** Given a review aggregate updates `listings.avg_rating`, when `review.status_changed` is consumed, then `feed_rank_scores.invalidated_at = now()` for the affected listing; the next sweep recomputes the score using the new `avg_rating`.
- **AC-010** Given a provider is suspended (`users.status='suspended'`), when any feed read path runs, then the suspended provider's listings are excluded by the `JOIN users u WHERE u.status='active'` predicate even if the listing's status is still `active` due to lag.
- **AC-011** Given a non-KYC-approved provider with a published listing, when a feed read runs, then the listing IS visible and its `sig_kyc` contributes 0 to the score.
- **AC-012** Given two promoted listings active for the same page, when the response is assembled, then both appear in the `promoted` slot AND neither appears in the `organic` slot.
- **AC-013** Given a 51st `POST /feed/viewed` from the same user, when the trigger fires, then `recently_viewed` retains exactly 50 entries (oldest dropped via `[1:50]` slice) atomically regardless of concurrent writes.
- **AC-014** Given an attempt to save an 11th saved search, when the INSERT/UPDATE runs, then the DB CHECK rejects with a constraint-violation error.
- **AC-015** Given an anonymous IP exceeds 60 req/min, when the next request arrives, then the response is `429 Too Many Requests` with `Retry-After`.
- **AC-016** Given three rate-limit violations within 10 minutes, when the fourth limit-hit fires, then `Retry-After` is `2^n` (where n = violation count after the first three) capped at 300, and a `feed_abuse_events` row is inserted.
- **AC-017** Given a User-Agent header is rotated across requests from the same trusted IP, when the rate limiter computes the fingerprint, then both requests share the same `SHA-256(trusted_lb_ip)` and count toward the same window.
- **AC-018** Given an empty multi-filter result set, when the response is assembled, then `total_estimate=0` and `total_capped=false` are returned, allowing the client UI to surface filter-removal affordances.
- **AC-019** Given more than 1000 candidates match a filter combination, when the response is assembled, then `total_estimate=1000` and `total_capped=true`.
- **AC-020** Given a malformed cursor token (bad signature), when the request is processed, then the response is `400 invalid_cursor` with no listing data leaked.

## 6. Test Automation Strategy

- **Test levels**: Unit (canonical formula function, signal computations, qualifying-reporter style filters), Integration (cache miss + lock + DB rebuild path; INSERT-on-publish handler; sweep with seeded invalidations; promoted/organic dedup), E2E (full filter + cursor + total-estimate flows; rate-limit windows).
- **Frameworks**: Project standard — pytest/Vitest; testcontainers for Postgres 15 + Redis 7; deterministic time injection for the sweep cadence test.
- **Test data**: factory fixtures for active listings, suspended providers, promoted slots, saved searches at the 10-cap boundary, recently-viewed at the 50-cap boundary.
- **CI/CD**: `CREATE INDEX CONCURRENTLY` migrations applied outside transactions in CI; fail the pipeline if a migration that includes CONCURRENTLY is wrapped in a transaction.
- **Coverage**: ≥85 % on canonical formula function and INSERT path; ≥75 % on cache + lock paths.
- **Performance**: feed read p95 ≤ 150 ms at 1000 active listings; total-estimate count ≤ 50 ms at 5000 candidates; sweep processes 200 invalidated rows in ≤ 60 s wall clock.

## 7. Rationale & Context

**Why a single canonical formula.** Three formulas at three call sites (R1's design) silently produced incommensurable scores between the stored value and the runtime ranking. Encapsulating the formula as `feed_base_score(...)` SQL function and forcing both INSERT and read paths to call it eliminates the drift; the q path adds `ts_rank_cd` as an additive term with proportional re-weighting, not a different base.

**Why score-keyset cursor with a depth cap.** A page-1-by-score / page-2+-by-recency split (R2's first attempt) leaves a recency gap: listings ranked highly by score but published mid-corpus are skipped on page 2. Using `(score, id)` consistently across pages preserves order; the 20/5 page caps bound the drift caused by mid-session rescores. Score-keyset is stable enough at any reasonable corpus size and rescore cadence (60 s).

**Why `users.status='active'` defense-in-depth.** Listings state machine consumers can lag (queue back-pressure, deploy windows, manual data fixes). A read-time JOIN on `users.status` makes the worst-case visibility window equal to the time it takes the auth UPDATE to commit — which is faster than any event-driven path. KYC is explicitly NOT a visibility gate per CLAUDE.md; suspended-provider exclusion via `users.status` is the correct backstop.

**Why generation counter over SCAN.** SCAN+UNLINK scales O(N) over the keyspace and degrades Redis under bulk invalidation events (auto-pause cascade, category archive). `INCR feed:anon:gen` is O(1) and instantly orphans every stale cache entry; natural TTL reclaims memory.

**Why single-flight on cache miss.** After `INCR feed:anon:gen`, every concurrent anonymous request misses the cache; without single-flight, the DB receives a thundering herd. Reusing the Categories pattern (SET NX EX 5 + 200 ms × 10 poll + fall through) keeps the DB warm and the cache rebuild deterministic.

**Why event-driven INSERT on `listing.published`.** Waiting for the next 60-second sweep means a published listing is invisible on the relevance sort for up to a minute. INSERTing inline at publish time bounds time-to-visibility to event-handling latency (sub-second) while the sweep handles ongoing invalidations.

**Why `ts_rank_cd` not `ts_rank`.** `ts_rank_cd` (cover density) accounts for the proximity of query terms within the document, producing a more useful relevance signal for short titles and descriptions. The normalization flag 32 (mean harmonic distance) is a standard PostgreSQL idiom for documents of varying length.

**Why no PostGIS or external search engine at v1.** Both add operational surface area. Listings already carries `location_city_id`/`location_region_id` INT FKs; the city-or-remote predicate is sargable on existing indexes. PostgreSQL `tsvector` GIN with `ts_rank_cd` is empirically adequate at MVP corpus size; GUD-002 names a measured trigger for revisiting Meilisearch.

**Why `recently_viewed` is exclusion-only at v1.** A hard filter would hide all listings for a user who has viewed them all in a sparse category — empty results with no recovery path. Exclusion-as-ranking-penalty (or no penalty at v1) is the conservative choice; the column exists primarily to power future personalization.

**Why no PostGIS / no facet counts / no per-facet data at v1.** `total_estimate` solves the empty-result UX problem at minimal cost (one extra capped count). Per-facet counts require either an expensive aggregation or a denormalized `feed_facet_counts` table; neither is justified before measured demand.

**Why admin-only promotions at v1.** Self-serve promotions require billing integration, an auction model, and a moderation pipeline for ad creative. Admin-only at v1 lets the schema and disclosure surface stabilize before monetization complexity is added.

**Why drop User-Agent from the rate-limit fingerprint.** UA rotation is trivial in any HTTP client; including UA in the fingerprint produces false security and exacerbates collateral 429s on shared CGNAT IPs. Trusted-LB-IP is honest about its scope.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** Listings module — produces `listing.published`, `listing.updated`, `listing.status_changed` events; provides `listings.fts_vector`, `idx_listings_fts`, `idx_listings_active_cursor`, `avg_rating`, `review_count`, location/price columns.
- **EXT-002** Reviews module — produces `review.status_changed`; writes `listings.avg_rating` and `review_count` consumed as the `sig_review_score` source.
- **EXT-003** Categories module — produces `category.archived`, `category.approved`; provides the 3-level tree structure for subtree expansion.
- **EXT-004** Auth / Users module — provides `users.status` (defense-in-depth gate), `provider_profiles.kyc_status`, `provider_profiles.headline`, `provider_profiles.completed_deals_count`, `user_profiles.bio`, `user_profiles.avatar_url`.
- **EXT-005** Deal Workflow module — consumed transitively via `provider_profiles.completed_deals_count`; no direct event consumption.

### Third-Party Services
- (None at v1.)

### Infrastructure Dependencies
- **INF-001** PostgreSQL 15+ with `pg_trgm`, `pgcrypto`; `IMMUTABLE` SQL functions; partial indexes; `CREATE INDEX CONCURRENTLY`.
- **INF-002** Redis 7 with Lua, single-flight `SET NX EX`, `INCR`, basic GET/SET with TTL.
- **INF-003** Outbox dispatcher (existing) for the events EXT-001..EXT-004 emit.
- **INF-004** PagerDuty (or equivalent) for sweep backlog and abuse-event-volume alerts.

### Data Dependencies
- **DAT-001** `listings` table read access for joins; `provider_profiles` and `user_profiles` for signal columns; `users` for the visibility gate.

### Technology Platform Dependencies
- **PLT-001** Standard project stack; no new platform-level dependencies introduced.

### Compliance Dependencies
- **COM-001** Promoted-content disclosure — `Реклама` label is rendered verbatim alongside every promoted card, satisfying Ukrainian advertising law and EU DSA Article 26 transparency requirements.
- **COM-002** GDPR / ЗУ "Про захист персональних даних" — `feed_user_state` rows are CASCADE-deleted on user erasure; no special handler.

## 9. Examples & Edge Cases

### Example 1 — Anonymous browse, page 1 → page 2

```text
Page 1 request:  GET /feed?category_id=<uuid>&limit=20
Cache miss → SET NX lock → DB query (CTE, 2 promoted + 18 organic) → SET cache → return 20.
Cursor returned: { score: 0.7821, id: "...", v: 1 } HMAC-signed.

Page 2 request:  GET /feed?category_id=<uuid>&cursor=<token>&limit=20
Decode → verify → predicate (frs.score, l.id) < (0.7821, "...") → return next 20 (no promoted block, organic only).
```

### Example 2 — Listing publication

```text
T+0    Listings emits listing.published(id=<L>).
T+0+ε  Feed worker:
       INSERT INTO feed_rank_scores (...) ON CONFLICT DO UPDATE.
       INCR feed:anon:gen.   -- new listing might be in cached pages
T+0+ε+  GET /feed sees the listing on page 1 of relevance sort
       (assuming top score under the active filters).
```

### Example 3 — Provider suspension, instant feed exclusion

```text
T+0  Auth UPDATE users SET status='suspended' WHERE id=<P>.
T+1  GET /feed runs. The JOIN users u WHERE u.status='active' excludes <P>'s listings.
     Result: <P>'s listings are gone from the feed at T+1, with no event/cache
     dependency and no reliance on the Listings auto_pause path completing.
```

### Example 4 — Archived-category cursor session

```text
T+0   User starts paginating /feed/categories/<C>.
T+10s Admin archives <C>; outbox fires category.archived.
T+10s Feed worker: INCR feed:anon:gen + DEL cat:subtree:v1:<C>.
T+11s User requests page 2 with cursor token.
      App-tier local cache for "category <C> active?" expires within 5 s and
      checks DB; status='archived' → response 410 Gone {code:FEED_CATEGORY_ARCHIVED}.
      Client UI removes the category filter; fresh request lands on the unfiltered feed.
```

### Example 5 — Two promoted listings dedup'd from organic

```text
Promoted CTE returns IDs [A, B] (top of the page).
Organic CTE: WHERE l.id NOT IN (A, B) ORDER BY frs.score DESC LIMIT 18.
Response: [{slot:'promoted', id:A}, {slot:'promoted', id:B}, {slot:'organic', ...}*18].
A and B do NOT appear in the organic block of the same page.
```

### Edge case — Concurrent `POST /feed/viewed` from two tabs

```text
Tab 1 prepends listing X. Trigger slices to 50.
Tab 2 prepends listing Y. Trigger slices to 50.
Final state: 50 entries with [Y, X, ...] at the head; the lost-update on the
intermediate 51-element value is benign because the trigger always re-slices.
```

### Edge case — Q-path pagination beyond depth cap

```text
GET /feed/search?q=ремонт&cursor=<token>  encoding depth=6.
Response: 400 pagination_depth_exceeded (q-path cap is 5).
```

### Edge case — All signals zero on publish

```text
A brand-new listing where the provider has no KYC, no bio, no avatar, no completed deals,
and the listing has no rating: feed_base_score(recency=1, 0, 0, 0, 0) = 0.35.
Listing appears below established providers but well above NULL-score rows on relevance.
```

## 10. Validation Criteria

- All ACs in §5 pass in integration tests against testcontainers Postgres 15 + Redis 7.
- `feed_base_score` is the only place coefficients appear; grep returns one definition site.
- The INSERT path on `listing.published` and the 60-second sweep both call `feed_base_score(...)`; no inline weighted sum exists in either path.
- The visibility WHERE clause in every read CTE includes `l.status='active' AND u.status='active'` and does NOT include `pp.kyc_status='approved'`.
- `ts_rank_cd` appears only on the q-path read query; it is never written to `feed_rank_scores`.
- The Redis cache key shape includes `{gen}`; INCR `feed:anon:gen` is observed on every consumer of `listing.status_changed` / `category.archived` / promotion changes.
- The single-flight lock keys (`feed:anon:lock:*`, `cat:subtree:lock:*`) use `SET NX EX 5` and pollers wait 200 ms × 10.
- `recently_viewed` cap is enforced by a `BEFORE INSERT OR UPDATE` trigger with no column predicate.
- `idx_feed_rank_scores_score` has no `WHERE` clause; partial-index linting in CI rejects PRs that re-introduce the redundant predicate.
- Pagination depth cap is enforced for both modes; reaching the cap returns 400, not silently empty pages.
- `total_estimate` is returned on every feed response; clients render filter-removal affordances when `total_estimate=0 AND total_capped=false`.
- The rate-limit fingerprint is `SHA-256(trusted_lb_ip)`; UA does not appear in the fingerprint computation.
- Cursor tokens fail validation when re-signed with a different secret; tampered tokens return 400.

## 11. Related Specifications / Further Reading

- [`spec-architecture-listings.md`](./spec-architecture-listings.md) — `listings` table, `fts_vector`, `idx_listings_fts`, `idx_listings_active_cursor`, location/price/service_type columns; emits `listing.published` / `listing.updated` / `listing.status_changed`.
- [`spec-architecture-reviews.md`](./spec-architecture-reviews.md) — owns `listings.avg_rating` and `review_count` writes; emits `review.status_changed` triggering Feed re-aggregation invalidation.
- [`spec-data-category-tree.md`](./spec-data-category-tree.md) — 3-level category tree; emits `category.approved` / `category.archived`; defines the single-flight cache pattern (GUD-001) reused here.
- [`spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — Deal terminal states feed `provider_profiles.completed_deals_count` (consumed transitively).
- [`spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — `provider_profiles.kyc_status` enum used by `sig_kyc`.
- [`spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `users.status` (defense-in-depth gate); `provider_profiles.headline`; `user_profiles.bio`, `user_profiles.avatar_url` consumed by `sig_profile_complete`.
- [`spec-architecture-marketplace-social-platform.md`](./spec-architecture-marketplace-social-platform.md) — top-level architecture context.
