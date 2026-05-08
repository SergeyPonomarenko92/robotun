---
title: Search & Discovery — Listings + Providers FTS, Faceted, Autocomplete
version: 1.0
date_created: 2026-05-08
last_updated: 2026-05-08
owner: Platform / Discovery
tags: [architecture, search, discovery, fts, facets, autocomplete, ranking]
---

# Introduction

Module 13 — Search/Discovery is the explicit-query search surface for Robotun. It complements Feed (which is a personalized browse) with intentional `q=`-driven retrieval over listings (primary) and provider profiles (secondary). It reuses Feed's ranking formula and `feed_rank_scores.score` to ensure consistency between Feed and Search rankings, applies faceted filtering with inline aggregation, supports autocomplete via a dedicated suggest index, and writes anonymized analytics into a partitioned `search_queries` table.

## 1. Purpose & Scope

This specification defines:

- Two REST endpoints: `GET /search/listings` and `GET /search/providers`. Each carries its own ranking formula, cursor shape, and facet model.
- Autocomplete endpoint `GET /search/suggest` backed by a dedicated `search_suggest_index` table populated by a worker consuming listing/category outbox events.
- Listing search ranking: identical to Feed q-path — `0.80 * frs.score + 0.20 * ts_rank_cd(fts_vector, query, 32)` for display order, but cursor is keyed on `(frs.score, id)` only (filter-and-display, not sort key).
- Provider search ranking: `provider_quality_score = 0.40 * review_score + 0.30 * deal_count + 0.20 * kyc + 0.10 * profile_complete`.
- Faceted aggregation via a single CTE capped at 1000 candidates; categories, price buckets, rating buckets.
- FTS dictionary follows Listings GUD-001: `'simple'` default + opportunistic `'ukrainian'` if installed (read from `platform_settings.listing_fts_dictionary_mode` cached 60 s).
- Analytics: async fire-and-forget INSERT into `search_queries` (partitioned monthly, 12-month retention), idempotent rollup into `search_popular_queries`, GDPR anonymization at T+30d (NULLs `query_hash` AND `user_id`).
- Click analytics with IDOR-resistant validation: `clicked_listing_id` must be a member of the cached `search:result_ids:{search_id}` set.
- Redis caching: anon-only, generation-counter keys, no SCAN-based invalidation.
- Provider `search_vector` maintained by a single consolidated trigger with `FOR UPDATE` lock to prevent display-name/headline race.

**Hard prerequisite — Module 13 cannot ship before:**
- **Deal spec v1.3 amendment** — adds `provider_profiles.completed_deals_count INTEGER NOT NULL DEFAULT 0` with write-path on `deal.approved` / `deal.auto_completed` (increment) and `deal.dispute_resolved{outcome=refund_to_client}` (decrement, floor 0).
- Until v1.3 lands, Search uses subquery fallback `(SELECT COUNT(*) FROM deals WHERE provider_id=pp.user_id AND status='completed')` marked `-- COMPAT: remove after Deal v1.3`.

**Audience:** backend, mobile, T&S (analytics consumer), SRE.

**Assumptions:** PostgreSQL 15+, Redis 7+, REST/JSON over HTTPS, JWT (RS256). Modules 1–12 finalized.

**Out of scope:** spell correction / "Did you mean?", radius/PostGIS geo search, Elasticsearch/Meilisearch migration, ML personalization in Search (Feed owns personalization), A/B testing of ranking weights, search-result saved searches (Feed owns saved searches storage), provider bio as search signal at MVP, multi-currency search, "universal search" cross-scope endpoint, admin search analytics dashboard (covered by Module 12), Hunspell/Ukrainian morphological FTS at MVP (uses `simple` tokenizer with opportunistic `ukrainian` upgrade).

## 2. Definitions

- **Search scope** — `listings` or `providers`; each has its own ranking, cursor, and facet shape.
- **`q`** — user-provided query string; max 200 chars; required on search endpoints, optional on suggest.
- **`frs.score`** — precomputed `feed_rank_scores.score` from the Feed module; reused as the quality signal in listing search.
- **`fts_vector`** — `to_tsvector(<dict>, ...)` STORED column on `listings` (Listings module); dictionary chosen at migration time per GUD-001.
- **`provider_quality_score`** — provider-search-specific score (review/deal/KYC/profile-complete signals).
- **Facet** — aggregation count for a filter dimension (category, price bucket, rating bucket).
- **`search_id`** — server-generated UUID returned in search response, used to validate click analytics.
- **`gen`** — generation counter for cache key namespacing; INCR on invalidation events.
- **Suggest** — autocomplete; prefix-tokenized lookup against `search_suggest_index`.
- **No-results relaxation** — secondary facet query with one filter dropped, returned alongside zero-result response.

## 3. Requirements, Constraints & Guidelines

### Requirements

- **REQ-001** — `GET /search/listings` requires non-empty `q`; without query, return `400 query_required`.
- **REQ-002** — Listing search ranking: display order `ORDER BY 0.80 * frs.score + 0.20 * ts_rank_cd(fts_vector, plainto_tsquery(<dict>, q), 32) DESC, id DESC`. Cursor predicate: `WHERE (frs.score, l.id) < (:cursor_score, :cursor_id)` only (no `ts_rank_cd` in cursor key).
- **REQ-003** — Listing search FTS gate: `WHERE l.fts_vector @@ plainto_tsquery(<dict>, q)` AND `l.status='active'` AND `u.status='active'`.
- **REQ-004** — Provider search ranking: `provider_quality_score = 0.40 * COALESCE((avg_rating - 1)/4.0, 0) + 0.30 * LEAST(completed_deals_count / 50.0, 1) + 0.20 * (kyc_status='approved')::int + 0.10 * (headline IS NOT NULL AND bio IS NOT NULL)::int`.
- **REQ-005** — Pagination depth cap: 5 pages on all search and suggest paths. Beyond page 5 → `400 pagination_depth_exceeded`.
- **REQ-006** — `q` length cap: max 200 characters for search, max 100 for suggest. Over-limit returns `400 query_too_long`.
- **REQ-007** — Default page size 20, max 50 (search) / 10 (suggest). Cursor tokens are HMAC-SHA256-signed with `v=1`.
- **REQ-008** — Facet aggregation: single CTE over candidate set capped at 1000 rows. Three dimensions: category, price bucket (4 ranges in kopecks), rating bucket (4 ranges).
- **REQ-009** — Empty-results response includes secondary facet aggregation with one filter relaxed (relaxation order: `price_max → min_rating → kyc_only → service_type`).
- **REQ-010** — `search_queries` analytics INSERT is fire-and-forget AFTER HTTP response (no retry on failure). Table partitioned by month on `executed_at`. Auto-create partitions one month ahead via pg_cron. Drop partitions >12 months old.
- **REQ-011** — `search_queries` GDPR anonymization at T+30d: NULL `user_id` AND `query_hash` AND `query_text` AND `ip_hash`. Retain `id`, `scope`, `filters_summary`, `result_count`, `executed_at`.
- **REQ-012** — Popular-queries worker idempotent: `search_queries.counted_at TIMESTAMPTZ` set in same TX as `search_popular_queries` upsert. `FOR UPDATE SKIP LOCKED` on the `WHERE counted_at IS NULL` candidate set.
- **REQ-013** — Suggest index populated by `search_suggest_consumer` worker consuming `listing.published`, `listing.archived`, `listing.status_changed`, `category.approved`, `category.archived` events.
- **REQ-014** — Cache key generation pattern: `search:results:{gen}:{scope}:{SHA256(canonical_params)}` and `search:suggest:{gen}:{scope}:{SHA256(q)}`. Generation counters seeded `SETNX 1` + `PERSIST` at deploy.
- **REQ-015** — Generation INCR triggers (Search-owned): `search:results:gen` INCR'd on `listing.published`, `listing.archived`, `listing.status_changed`, `category.archived`. Same triggers for `search:suggest:gen`.
- **REQ-016** — Single-flight cache rebuild: `SET NX EX 5` lock at `search:results:lock:{gen}:{scope}:{key_hash}`; pollers retry every 200 ms × 10 then fall through to direct DB (no cache write).
- **REQ-017** — Click analytics: `POST /search/click {search_id, clicked_listing_id}` validates via `SISMEMBER search:result_ids:{search_id} {clicked_listing_id}`. Redis SET stored on search execution, TTL 10 min. Per-(search_id,listing_id) dedup via `SETNX` 10-min key.
- **REQ-018** — Visibility gate enforced in every search query: `l.status='active' AND u.status='active'` on listings; `pp.user_id` joined `users` to verify `u.status='active'` on providers.

### Security

- **SCH-SEC-001** — Cursor tokens HMAC-SHA256 signed with platform secret (mirrors Feed SEC-001). `v=1`; mismatched version returns `400 invalid_cursor`.
- **SCH-SEC-002** — Click validation prevents IDOR poisoning: `clicked_listing_id` MUST be in `search:result_ids:{search_id}` SET. Failure → `422 click_invalid` + anomaly log.
- **SCH-SEC-003** — Anon rate-limit fingerprint: `SHA256(trusted_lb_ip)` (mirrors Feed SEC-002). User rate-limit: `user_id`. Three violations in 10 min → exponential backoff `Retry-After: 2^n` capped at 300 s.
- **SCH-SEC-004** — `search_queries` rows containing PII (query_text, ip_hash, user_id, query_hash) are anonymized at T+30d (REQ-011). After anonymization, no row can be re-identified to a specific user via SHA-256 reverse-lookup.
- **SCH-SEC-005** — Generation counter keys (`search:results:gen`, `search:suggest:gen`) are `PERSIST`'d in Redis (no TTL); Redis maxmemory-policy MUST be configured `volatile-lru` or equivalent so untimed keys are not evicted.

### Constraints

- **SCH-CON-001** — Module 13 cannot ship before Deal spec v1.3 amendment adds `provider_profiles.completed_deals_count` column.
- **SCH-CON-002** — `q` is mandatory on `/search/listings` and `/search/providers`. Browse-without-query is the Feed's domain.
- **SCH-CON-003** — Listing search ranking formula is identical to Feed q-path (`0.80 * frs.score + 0.20 * ts_rank_cd`). Divergence requires explicit amendment to BOTH Feed and Search specs in the same change set.
- **SCH-CON-004** — `platform_settings` table DDL is owned by the Listings spec. Search reads `listing_fts_dictionary_mode` only; no Search-specific keys.
- **SCH-CON-005** — `search_queries` retention 12 months; `search_popular_queries` retention indefinite (rolled-up aggregates have no PII linkage post-anonymization).
- **SCH-CON-006** — UAH-only at MVP (inherited from Listings CON-003).
- **SCH-CON-007** — Pagination depth cap 5 pages (mirrors Feed q-path cap).

### Guidelines

- **SCH-GUD-001** — When adding a new sort mode, document the cursor predicate explicitly. Compound keyset on `(sort_column, id)` is the only stable pattern.
- **SCH-GUD-002** — Migrate to Meilisearch or Elasticsearch when listing search p95 > 250 ms at 10 000+ active listings (same trigger as Feed GUD-002).
- **SCH-GUD-003** — Provider search lateral join for specializations is a v1 simplification. Promote to denormalized column on `provider_profiles` if provider search exceeds 100 results/page or p95 > 200 ms.
- **SCH-GUD-004** — Click validation `search:result_ids:{search_id}` Redis SETs are a small operational cost (<10 KB per search × 10 min TTL). Acceptable at MVP scale; reconsider at >10k searches/sec.

### Patterns

- **SCH-PAT-001** — Generation-counter cache keys for SCAN-free invalidation (mirrors Feed and Categories patterns).
- **SCH-PAT-002** — Single-flight rebuild via `SET NX EX 5` lock + 200 ms × 10 poll (mirrors Categories GUD-001).
- **SCH-PAT-003** — Idempotent worker via `counted_at IS NULL` + `FOR UPDATE SKIP LOCKED` (mirrors Notifications/Payments cursor patterns).
- **SCH-PAT-004** — Cursor keyset on `(materialized_score, id)` only — never on computed expressions.

## 4. Interfaces & Data Contracts

### 4.1 Schema

```sql
-- 4.1.1 search_queries (partitioned by month on executed_at)
CREATE TABLE search_queries (
  id              BIGSERIAL    NOT NULL,
  query_hash      TEXT,                                -- NULLed at T+30d (REQ-011)
  query_text      TEXT,                                -- NULLed at T+30d
  user_id         UUID         REFERENCES users(id) ON DELETE SET NULL,
  scope           TEXT         NOT NULL CHECK (scope IN ('listings','providers')),
  filters_summary JSONB        NOT NULL DEFAULT '{}'::jsonb,
  result_count    INT,
  search_id       UUID         NOT NULL,               -- echoed back; stored 10min in Redis
  ip_hash         TEXT,                                -- NULLed at T+30d
  counted_at      TIMESTAMPTZ,                         -- popular-query worker idempotency (REQ-012)
  executed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, executed_at)                        -- partitioning column in PK
) PARTITION BY RANGE (executed_at);

-- Initial partitions seeded by pg_cron job; example:
CREATE TABLE search_queries_2026_05 PARTITION OF search_queries
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX idx_sq_uncounted ON search_queries (executed_at) WHERE counted_at IS NULL;
CREATE INDEX idx_sq_user      ON search_queries (user_id, executed_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_sq_anon_age  ON search_queries (executed_at) WHERE query_text IS NOT NULL;

-- 4.1.2 search_popular_queries (rolled-up; permanent, no PII)
CREATE TABLE search_popular_queries (
  scope           TEXT         NOT NULL CHECK (scope IN ('listings','providers')),
  term            TEXT         NOT NULL,
  search_count    BIGINT       NOT NULL DEFAULT 0,
  last_searched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, term)
);
CREATE INDEX idx_spq_scope_count ON search_popular_queries (scope, search_count DESC);

-- 4.1.3 search_suggest_index (autocomplete corpus)
CREATE TABLE search_suggest_index (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  suggest_type TEXT         NOT NULL CHECK (suggest_type IN ('listing_title','category','popular_query')),
  text_value   TEXT         NOT NULL,
  weight       INT          NOT NULL DEFAULT 0,
  entity_id    UUID,                                   -- listing_id / category_id / NULL
  fts_prefix   TSVECTOR     GENERATED ALWAYS AS (to_tsvector('simple', text_value)) STORED,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_ssi UNIQUE (suggest_type, text_value)
);
CREATE INDEX idx_ssi_fts_prefix  ON search_suggest_index USING GIN (fts_prefix);
CREATE INDEX idx_ssi_type_weight ON search_suggest_index (suggest_type, weight DESC);

-- 4.1.4 Suggest consumer cursor
CREATE TABLE search_suggest_consumer_cursors (
  consumer_name TEXT        PRIMARY KEY,
  last_seen_id  BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO search_suggest_consumer_cursors (consumer_name)
  VALUES ('search_suggest_worker') ON CONFLICT DO NOTHING;

-- 4.1.5 Provider profile FTS (added by trigger to existing provider_profiles)
ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

CREATE INDEX idx_provider_profiles_fts
  ON provider_profiles USING GIN (search_vector);
CREATE INDEX idx_provider_profiles_fts_kyc
  ON provider_profiles USING GIN (search_vector) WHERE kyc_status = 'approved';

-- 4.1.6 Listings keyset indexes (CONCURRENTLY in production)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_price_keyset
  ON listings (price_amount ASC NULLS LAST, id ASC)
  WHERE status = 'active' AND price_amount IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_rating_keyset
  ON listings (avg_rating DESC NULLS LAST, id DESC)
  WHERE status = 'active';
```

### 4.2 Display-Name Sync Trigger (R11 fix)

```sql
CREATE OR REPLACE FUNCTION trg_sync_provider_search_vector()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_user_id UUID;
  v_headline TEXT;
  v_display_name TEXT;
BEGIN
  -- Resolve user_id from whichever table fired the trigger
  v_user_id := COALESCE(NEW.user_id, OLD.user_id);

  -- Lock provider_profiles row first (consistent ordering, prevents race)
  PERFORM 1 FROM provider_profiles
    WHERE user_id = v_user_id
    FOR UPDATE;

  SELECT headline INTO v_headline FROM provider_profiles WHERE user_id = v_user_id;
  SELECT display_name INTO v_display_name FROM user_profiles WHERE user_id = v_user_id;

  UPDATE provider_profiles
    SET search_vector = to_tsvector('simple',
          COALESCE(v_display_name, '') || ' ' || COALESCE(v_headline, ''))
    WHERE user_id = v_user_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pp_headline_sync
  AFTER UPDATE OF headline ON provider_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_sync_provider_search_vector();

CREATE TRIGGER trg_up_display_name_sync
  AFTER UPDATE OF display_name ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_sync_provider_search_vector();
```

### 4.3 Listing Search Query

```sql
-- GET /search/listings?q=X&category_id=&price_min=&price_max=&min_rating=&kyc_only=&region_id=&city_id=&sort=&cursor=&limit=
WITH
  -- Apply listing FTS gate first
  candidates AS (
    SELECT l.id, l.category_id, l.price_amount, l.avg_rating, l.published_at,
           l.title, l.pricing_type, l.currency, l.service_type,
           l.location_region_id, l.location_city_id, l.provider_id,
           ts_rank_cd(l.fts_vector, plainto_tsquery(:dict, :q), 32) AS text_rank,
           frs.score AS frs_score
    FROM listings l
    JOIN feed_rank_scores frs ON frs.listing_id = l.id
    JOIN users u              ON u.id = l.provider_id
    LEFT JOIN provider_profiles pp ON pp.user_id = l.provider_id
    WHERE l.status = 'active'
      AND u.status = 'active'
      AND l.fts_vector @@ plainto_tsquery(:dict, :q)
      AND (:category_ids IS NULL OR l.category_id = ANY(:category_ids))
      AND (:price_min   IS NULL OR l.price_amount >= :price_min)
      AND (:price_max   IS NULL OR l.price_amount <= :price_max)
      AND (:min_rating  IS NULL OR l.avg_rating   >= :min_rating)
      AND (:kyc_only IS FALSE OR pp.kyc_status = 'approved')
      AND (:region_id IS NULL OR l.location_region_id = :region_id OR l.service_type = 'remote')
      AND (:city_id   IS NULL OR l.location_city_id   = :city_id   OR l.service_type = 'remote')
    LIMIT 1000
  )
SELECT * FROM candidates
WHERE (:cursor_score IS NULL OR (frs_score, id) < (:cursor_score, :cursor_id))
ORDER BY 0.80 * frs_score + 0.20 * text_rank DESC, id DESC
LIMIT :limit;
```

### 4.4 Provider Search Query

```sql
-- GET /search/providers?q=X&min_rating=&kyc_only=&sort=&cursor=&limit=
WITH base AS (
  SELECT pp.user_id, pp.headline, pp.kyc_status,
         COALESCE(pp.completed_deals_count,
                  (SELECT COUNT(*) FROM deals d WHERE d.provider_id = pp.user_id AND d.status = 'completed')
         ) AS completed_deals_count,  -- COMPAT: remove after Deal v1.3 lands
         COALESCE(pp.avg_rating, 0) AS avg_rating,
         pp.review_count,
         up.display_name, up.bio, up.avatar_url,
         (0.40 * COALESCE((pp.avg_rating - 1) / 4.0, 0) +
          0.30 * LEAST(
            COALESCE(pp.completed_deals_count,
                     (SELECT COUNT(*) FROM deals d2 WHERE d2.provider_id = pp.user_id AND d2.status = 'completed')
            ) / 50.0, 1) +
          0.20 * (CASE WHEN pp.kyc_status = 'approved' THEN 1 ELSE 0 END) +
          0.10 * (CASE WHEN pp.headline IS NOT NULL AND up.bio IS NOT NULL THEN 1 ELSE 0 END)
         ) AS provider_quality_score
  FROM provider_profiles pp
  JOIN users u ON u.id = pp.user_id
  JOIN user_profiles up ON up.user_id = pp.user_id
  WHERE u.status = 'active'
    AND pp.search_vector @@ plainto_tsquery('simple', :q)
    AND (:min_rating IS NULL OR pp.avg_rating >= :min_rating)
    AND (:kyc_only IS FALSE OR pp.kyc_status = 'approved')
)
SELECT
  b.*,
  (SELECT ARRAY_AGG(DISTINCT l.category_id) FROM listings l
    WHERE l.provider_id = b.user_id AND l.status = 'active') AS specialization_category_ids,
  (SELECT COUNT(*) FROM listings l WHERE l.provider_id = b.user_id AND l.status = 'active') AS active_listing_count
FROM base b
WHERE (:cursor_score IS NULL OR (b.provider_quality_score, b.user_id) < (:cursor_score, :cursor_id))
ORDER BY b.provider_quality_score DESC, b.user_id DESC
LIMIT :limit;
```

### 4.5 Facet Aggregation CTE (listings)

```sql
-- Computed alongside the candidate set; capped at 1000 candidates
WITH candidates AS ( /* same as 4.3 */ ),
facet_categories AS (
  SELECT category_id, COUNT(*) AS count FROM candidates GROUP BY category_id
),
facet_price AS (
  SELECT
    CASE
      WHEN price_amount <  50000  THEN 'lt_500'
      WHEN price_amount < 200000  THEN '500_1999'
      WHEN price_amount < 500000  THEN '2000_4999'
      ELSE                             'gte_5000'
    END AS bucket, COUNT(*) AS count
  FROM candidates WHERE price_amount IS NOT NULL GROUP BY 1
),
facet_rating AS (
  SELECT
    CASE
      WHEN avg_rating >= 4.5 THEN '4.5_5'
      WHEN avg_rating >= 4.0 THEN '4_4.5'
      WHEN avg_rating >= 3.0 THEN '3_4'
      ELSE                        'lt_3'
    END AS bucket, COUNT(*) AS count
  FROM candidates WHERE avg_rating IS NOT NULL GROUP BY 1
)
SELECT
  (SELECT json_agg(json_build_object('category_id', category_id, 'count', count)) FROM facet_categories) AS categories,
  (SELECT json_agg(json_build_object('bucket', bucket, 'count', count)) FROM facet_price) AS price_buckets,
  (SELECT json_agg(json_build_object('bucket', bucket, 'count', count)) FROM facet_rating) AS rating_buckets;
```

### 4.6 Suggest Index Population Worker

```sql
-- Runs every 5 s, single-active via SELECT FOR UPDATE SKIP LOCKED on cursor row.
BEGIN;
SELECT last_seen_id FROM search_suggest_consumer_cursors
WHERE consumer_name = 'search_suggest_worker' FOR UPDATE SKIP LOCKED;
-- 0 rows → COMMIT, sleep 5s.

SELECT id, aggregate_type, event_type, payload
FROM   outbox_events
WHERE  id > $last_seen
  AND  aggregate_type IN ('listing','category')
  AND  event_type IN ('listing.published','listing.archived','listing.status_changed',
                      'category.approved','category.archived')
ORDER BY id ASC LIMIT 500;

-- For each event:
--   listing.published / listing.status_changed→active:
--     INSERT INTO search_suggest_index (suggest_type, text_value, entity_id, weight)
--     VALUES ('listing_title', NEW.title, NEW.id, 50)
--     ON CONFLICT (suggest_type, text_value) DO UPDATE SET updated_at = now();
--   listing.archived / listing.status_changed→archived:
--     DELETE FROM search_suggest_index WHERE suggest_type='listing_title' AND entity_id = NEW.id;
--   category.approved:
--     UPSERT category row.
--   category.archived:
--     DELETE category row.
--   AFTER each: INCR search:results:gen, INCR search:suggest:gen in Redis.

UPDATE search_suggest_consumer_cursors SET last_seen_id = $max, updated_at = now()
WHERE consumer_name = 'search_suggest_worker';
COMMIT;
```

### 4.7 Popular-Queries Worker (Idempotent, REQ-012)

```sql
-- Runs every 5 minutes
WITH batch AS (
  SELECT id, scope, query_text, result_count
  FROM search_queries
  WHERE counted_at IS NULL AND query_text IS NOT NULL
  FOR UPDATE SKIP LOCKED
  LIMIT 500
),
updated AS (
  UPDATE search_queries sq SET counted_at = now()
  FROM batch WHERE sq.id = batch.id
  RETURNING batch.scope, batch.query_text
)
INSERT INTO search_popular_queries (scope, term, search_count, last_searched_at)
SELECT scope, query_text, COUNT(*), now()
FROM updated GROUP BY scope, query_text
ON CONFLICT (scope, term) DO UPDATE
  SET search_count = search_popular_queries.search_count + EXCLUDED.search_count,
      last_searched_at = EXCLUDED.last_searched_at;
```

### 4.8 REST API

| Method | Path | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/search/listings` | optional | 30/min/user; 60/min/IP anon | FTS + facets |
| GET | `/api/v1/search/providers` | optional | 30/min/user; 60/min/IP anon | Provider FTS |
| GET | `/api/v1/search/suggest` | optional | 60/min/user; 120/min/IP anon | Autocomplete |
| POST | `/api/v1/search/click` | optional | 100/min/user (1 per (search_id, listing_id)) | Click analytics |

**`GET /api/v1/search/listings` response:**

```json
{
  "data": [ { "id":"uuid","title":"...", "_score": 0.7214, ... } ],
  "pagination": {
    "next_cursor": "<HMAC-signed base64>",
    "has_more": true,
    "limit": 20,
    "sort": "relevance",
    "max_pages": 5
  },
  "facets": {
    "categories": [ {"category_id":"uuid","count":14} ],
    "price_buckets": [ {"bucket":"500_1999","count":11} ],
    "rating_buckets": [ {"bucket":"4.5_5","count":8} ]
  },
  "facets_relaxed": null,
  "total_estimate": 23,
  "total_capped": false,
  "meta": { "search_id": "uuid", "query": "...", "applied_filters": {...} }
}
```

**Empty-results with relaxed facets (REQ-009):**

```json
{
  "data": [],
  "facets": { "categories":[], "price_buckets":[], "rating_buckets":[] },
  "facets_relaxed": {
    "filter_dropped": "price_max",
    "facets": { "categories":[...], "price_buckets":[...], "rating_buckets":[...] }
  },
  "total_estimate": 0,
  "total_capped": false,
  "meta": { "search_id": "uuid" }
}
```

**`POST /api/v1/search/click`:**

```json
// Request
{ "search_id": "uuid", "clicked_listing_id": "uuid" }

// 204 No Content (recorded; or duplicate-suppressed)
// 422 click_invalid (clicked_listing_id not in search:result_ids:{search_id})
// 429 rate_limit_exceeded
```

### 4.9 Cursor Token Format (HMAC-signed)

```
cursor = base64url( JSON({s, id, v}) ) + '.' + base64url(HMAC-SHA256(secret, payload))
where:
  relevance:    s = frs.score (NUMERIC), id = listing_id (UUID)
  newest:       s = published_at (ISO8601), id = listing_id
  price_asc:    s = price_amount (BIGINT kopecks), id = listing_id
  price_desc:   s = price_amount, id = listing_id
  rating_desc:  s = avg_rating (NUMERIC), id = listing_id
  v = 1
```

## 5. Acceptance Criteria

- **AC-001** — Given a listing search with `q='ремонт'`, When ranking computes, Then ORDER BY uses `0.80 * frs.score + 0.20 * ts_rank_cd` (matches Feed q-path).
- **AC-002** — Given a relevance-sort search across 3 pages, When pagination is followed, Then the same listing never appears on two pages and no listing is silently skipped (cursor is `(frs.score, id)`-keyed).
- **AC-003** — Given Deal v1.3 absent, When provider search runs, Then `completed_deals_count` is computed via subquery fallback and the response is identical to post-amendment behavior.
- **AC-004** — Given a search with zero results due to `price_max` filter, When the response is built, Then `facets_relaxed` is non-null with `filter_dropped='price_max'` and aggregations from the relaxed corpus.
- **AC-005** — Given a `clicked_listing_id` not in `search:result_ids:{search_id}`, When `POST /search/click`, Then `422 click_invalid` returned and anomaly logged.
- **AC-006** — Given `listing.published` event fires, When the suggest consumer processes it, Then a row is upserted in `search_suggest_index` AND `search:suggest:gen` is INCR'd in Redis.
- **AC-007** — Given outbox re-delivery of a search event, When the popular-queries worker re-processes, Then `counted_at` prevents double-increment of `search_popular_queries.search_count`.
- **AC-008** — Given concurrent updates to `provider_profiles.headline` and `user_profiles.display_name` for the same provider, When triggers fire, Then the final `search_vector` reflects both new values (no stale-read race).
- **AC-009** — Given Redis is flushed mid-day, When a search request arrives, Then `search:results:gen` auto-initializes to 1 via `INCR`; cache hit returns expected fresh data after rebuild.
- **AC-010** — Given a search at T0, When 30 days pass, Then the anonymization sweep NULLs `query_hash`, `query_text`, `user_id`, and `ip_hash` for that row; `id`, `scope`, `filters_summary`, `result_count`, `executed_at` remain.
- **AC-011** — Given page 6 is requested via cursor, When the request fires, Then `400 pagination_depth_exceeded` returned.
- **AC-012** — Given anonymous user issues 31 searches in 1 minute from same IP, When the 31st request arrives, Then `429 rate_limit_exceeded` with `Retry-After`.
- **AC-013** — Given `kyc_only=true`, When provider search runs, Then the planner uses partial index `idx_provider_profiles_fts_kyc` (verify via EXPLAIN in integration test).
- **AC-014** — Given `q` longer than 200 chars, When request fires, Then `400 query_too_long`.
- **AC-015** — Given `search_queries.counted_at` is NULL for 1000 rows, When the popular-queries worker runs, Then it processes 500 rows in batch with `FOR UPDATE SKIP LOCKED`; concurrent worker processes the next 500.

## 6. Test Automation Strategy

- **Test Levels:** Unit (cursor token signing/validation, ranking formula, facet bucketing, regex normalization), Integration (PG + Redis, FTS dictionary fallback, generation counter invalidation, suggest consumer cursor), End-to-End (full search flow with click validation, GDPR anonymization sweep).
- **Frameworks:** project-default backend test stack.
- **Test Data:** seeded listings with diverse FTS vectors; provider profiles with completed_deals_count; mock outbox events to drive suggest worker.
- **CI/CD:** integration tests against ephemeral PG + Redis. EXPLAIN-based assertions on partial index usage.
- **Coverage:** ≥85% line coverage on Search service.
- **Performance:** sustained 100 search RPS for 30 min; assert p99 listing search < 250 ms; suggest p99 < 50 ms (Redis hit), < 200 ms (Redis miss).
- **Concurrency:** trigger race test for display-name/headline sync; popular-queries worker idempotency under restart.

## 7. Rationale & Context

**Why ranking matches Feed (REFINED R1):** divergent ranking between Feed and Search is the worst possible UX — same query, different orders. Reusing `0.80 * frs.score + 0.20 * ts_rank_cd` ensures consistency and lets ranking-tuning happen in one place (Feed spec). The 0.60/0.40 split from R1 was rejected because it implies Search is a different product when it is the same retrieval over the same listings.

**Why cursor on `(frs.score, id)` only (REFINED R3):** computed expressions in cursor predicates produce re-rank drift across `ANALYZE` cycles and `frs.score` sweep updates. Anchoring the cursor to a stored, materialized score column eliminates drift. Display order can still combine `ts_rank_cd` for visible ranking — only pagination stability requires a stable key.

**Why no `random()` (REFINED R4):** non-deterministic ORDER BY breaks keyset pagination outright. UUID `id` tiebreaking is sufficient. If pinning becomes a fairness problem (same providers always at top), revisit with deterministic per-listing salt (`hashtextextended(id, 0)`); not needed at MVP.

**Why generation counter for suggest (REFINED R5):** SCAN-based cache invalidation degrades under bulk events. Mirroring the Feed pattern keeps invalidation O(1) and avoids Redis blocking.

**Why fire-and-forget analytics (REFINED R7):** synchronous INSERT on every search adds DB write to the hot path. Acceptable analytics loss < 0.1% under normal operations is the right tradeoff.

**Why anonymize `query_hash` AND `user_id` (REFINED R8):** retaining `query_hash + user_id` allows rainbow-table re-identification. GDPR Art.4(5) pseudonymisation requires the linkage cannot be reconstructed; SHA-256 of common queries is reversible. Rolled-up `search_popular_queries` carries no user linkage and serves all analytics needs post-30d.

**Why click validation (REFINED R14):** without validation, click analytics are pollutable by any authenticated user. `SISMEMBER` against a 10-minute TTL Redis SET is cheap and prevents poisoning.

**Why Deal v1.3 prereq for `completed_deals_count`:** Feed and Search both reference this column. The Reviews spec adds rating denormalization but not deal count. The Deal module is the natural owner — it's the one that knows when a deal is completed. Until v1.3 lands, the subquery fallback works correctly but is more expensive.

**Why provider search uses `'simple'`:** display names and headlines are short proper nouns; stemming harms precision. Listing search uses opportunistic `'ukrainian'` because listing bodies are longer and benefit from morphological matching.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** — None. All search runs in-process against PostgreSQL + Redis.

### Third-Party Services
- **SVC-001** — Prometheus for `search_consumer_cursor_lag_seconds`, `search_query_p99_ms`, `search_cache_hit_ratio`.

### Infrastructure Dependencies
- **INF-001** — PostgreSQL 15+ with `pg_cron` for partition automation.
- **INF-002** — Redis 7+ with `volatile-lru` maxmemory-policy (or equivalent that excludes `PERSIST`'d keys).

### Data Dependencies
- **DAT-001** — `listings.fts_vector` (Listings module), `listings.status`, `listings.category_id`, etc.
- **DAT-002** — `feed_rank_scores.score` (Feed module).
- **DAT-003** — `provider_profiles.completed_deals_count` (Deal v1.3 amendment, prerequisite).
- **DAT-004** — `provider_profiles.avg_rating`, `review_count` (Reviews module).
- **DAT-005** — `platform_settings.listing_fts_dictionary_mode` (Listings module).

### Technology Platform Dependencies
- **PLT-001** — PostgreSQL 15+ (partitioning, generated columns).
- **PLT-002** — `pg_cron` for monthly partition automation.

### Compliance Dependencies
- **COM-001** — GDPR Art.4(5) pseudonymisation; Art.17 right to erasure (covered by anonymization sweep at T+30d).
- **COM-002** — ЗУ "Про захист персональних даних" (same scope).

## 9. Examples & Edge Cases

### 9.1 Listing search response (relevance sort)

```json
GET /api/v1/search/listings?q=%D1%80%D0%B5%D0%BC%D0%BE%D0%BD%D1%82&limit=2

200 OK
{
  "data": [
    { "id":"uuid1","title":"Ремонт ноутбуків","price_amount":80000,"avg_rating":4.85,"_score":0.85 },
    { "id":"uuid2","title":"Ремонт смартфонів","price_amount":50000,"avg_rating":4.60,"_score":0.78 }
  ],
  "pagination": { "next_cursor":"...","has_more":true,"limit":2,"sort":"relevance","max_pages":5 },
  "facets": { "categories":[...], "price_buckets":[...], "rating_buckets":[...] },
  "total_estimate": 23, "total_capped": false,
  "meta": { "search_id":"uuid","query":"ремонт" }
}
```

### 9.2 Edge case — relaxed facets on zero results

```json
{ "data": [], "facets": {...empty}, "facets_relaxed": {
  "filter_dropped": "min_rating",
  "facets": { "categories":[{"category_id":"uuid","count":4}], ... }
}}
```

### 9.3 Edge case — Deal v1.3 absent

Provider search SQL falls back to `(SELECT COUNT(*) FROM deals WHERE provider_id=pp.user_id AND status='completed')` for `completed_deals_count`. Performance: extra subquery per row in the result set; acceptable at <100 results/page. Marked `-- COMPAT: remove after Deal v1.3` in code.

## 10. Validation Criteria

A compliant implementation MUST:

1. Pass AC-001 through AC-015.
2. Reject divergent ranking formula in code review (must match Feed q-path verbatim).
3. Reject any `random()` in ORDER BY across all search SQL.
4. Reject any `SCAN`-based cache invalidation; only generation-counter pattern allowed.
5. Verify `search_queries` partitioning is created via `pg_cron` automation in CI.
6. Verify GDPR anonymization sweep NULLs all four columns at T+30d.
7. Verify click validation via Redis SET membership in integration test.
8. Provide partial index usage assertion for `kyc_only=true` provider search.

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-feed.md`](./spec-architecture-feed.md) — ranking formula source; cursor pattern; generation counter pattern.
- [`spec/spec-architecture-listings.md`](./spec-architecture-listings.md) — `listings`, `fts_vector`, `platform_settings.listing_fts_dictionary_mode`, GUD-001 dictionary fallback.
- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — **REQUIRES v1.3 amendment** for `provider_profiles.completed_deals_count`.
- [`spec/spec-architecture-reviews.md`](./spec-architecture-reviews.md) — `provider_profiles.avg_rating`, `review_count`.
- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `user_profiles.display_name`, `bio`, `users.status`.
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — categories tree, `category.approved`/`category.archived` events.
- [`spec/spec-architecture-notifications.md`](./spec-architecture-notifications.md) — generation counter pattern reuse.
