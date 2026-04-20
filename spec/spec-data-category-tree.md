---
title: Category Tree (DAT-001)
version: 1.0
date_created: 2026-04-18
last_updated: 2026-04-18
owner: Platform / Data Team
tags: [data, schema, categories, moderation, marketplace]
---

# Introduction

This specification defines the category hierarchy, the user-proposal moderation workflow, slug normalization, storage schema, REST API, caching, authorization, audit, and GDPR erasure paths for the Robotun marketplace. It is a data-layer module consumed by Listings, Search, and Feed, and depends on the roles (`client`, `provider`, `moderator`, `admin`) and shared infrastructure (`audit_events`, transactional outbox) introduced in the Users & Authentication spec.

## 1. Purpose & Scope

**In scope**

- Logical and physical schema for category tree (depth 1–3, hybrid editorial + user-proposed).
- Slug normalization pipeline (Ukrainian KMU-2010 transliteration).
- Proposal lifecycle (`pending → approved | rejected | auto_rejected`) and concurrency model.
- REST API for category read, proposal submission, proposer self-view, admin moderation, admin direct creation, and archival.
- Caching and cache-invalidation strategy (Redis) and AC-014 ≤60 s latency budget.
- Authorization matrix, rate limits, and SEC-006 re-read for high-impact actions.
- Domain events (outbox) and compliance audit events (audit_events).
- GDPR erasure path for proposals on user soft-delete.
- Shared `outbox_events` table DDL (retroactively referenced by the Users & Authentication spec).

**Out of scope**

- Reparenting (moving a subtree). Forbidden at the DB level in MVP; will be designed in a future spec if needed.
- Multi-locale category names (single `uk` locale for MVP; additive `category_translations` table is post-MVP).
- Listings table and its trigger — defined by the Listings spec; this spec pins an explicit cross-module contract (CROSS-001).
- Notification delivery (messaging infrastructure) — consumes `category.*` outbox events but is owned elsewhere.

**Audience:** backend engineers, platform/data engineers, security reviewers, QA, AI code-generation agents producing DDL and service code.

## 2. Definitions

| Term | Definition |
|------|------------|
| Category | A node in the tree. `level` ∈ {1,2,3}. Roots are level 1, leaves are level 3. |
| Proposal | A user submission to add a non-root category under an existing parent. |
| Slug | A URL-safe lowercase ASCII identifier derived from the name by the normalization pipeline. |
| KMU-2010 | Official Ukrainian Cyrillic → Latin transliteration standard (Cabinet of Ministers Resolution No. 55, 2010-01-27). |
| Outbox | Transactional outbox table (`outbox_events`) used for at-least-once delivery of domain events to downstream consumers. |
| Audit log | The append-only, monthly-partitioned `audit_events` table defined in the Users & Authentication spec. |
| Race loser | A pending proposal whose slug matches another proposal that was approved first. |
| AC-014 | Umbrella-spec acceptance criterion: approved category must be selectable in Listing and visible in `GET /categories` within 60 seconds. |

## 3. Requirements, Constraints & Guidelines

### Functional Requirements

- **REQ-001**: The system SHALL store categories as an adjacency list with an explicit `level` column constrained to {1,2,3}.
- **REQ-002**: The system SHALL allow any authenticated user to submit a proposal for a non-root category under an existing active parent.
- **REQ-003**: The system SHALL NOT allow users to create root (level-1) categories. Root creation is admin-only via a separate endpoint.
- **REQ-004**: The system SHALL compute the proposal slug server-side from the submitted name using the normalization pipeline in §4.3. Users SHALL NOT supply slugs on the proposal path.
- **REQ-005**: On proposal approval, admins MAY supply a `slug_override` to resolve homograph collisions.
- **REQ-006**: The system SHALL enforce global slug uniqueness across active categories AND pending proposals (see §4.4).
- **REQ-007**: Approved categories SHALL appear in `GET /categories` and be selectable in Listing creation within 60 seconds of the approval transaction commit (AC-014).
- **REQ-008**: The system SHALL append an audit event for every category write action (proposal create, approve, reject, auto-reject, archive, admin create, name edit).
- **REQ-009**: The system SHALL emit a domain event via the transactional outbox for every category write action for consumption by Feed, Search, and Notifications.
- **REQ-010**: Archived categories SHALL remain referenceable by existing listings but SHALL NOT accept new listings or new proposals under them.
- **REQ-011**: On soft-delete of a user (per Users & Authentication spec AC-009), all pending proposals authored by that user SHALL be auto-rejected with `rejection_code='proposer_deleted'`.

### Security Requirements

- **SEC-001**: High-impact category actions (approve, reject, archive, admin create, name edit) SHALL re-read the actor's role from the primary database and SHALL NOT rely solely on JWT claims (consistent with Users & Authentication spec SEC-006).
- **SEC-002**: Rate limits SHALL be enforced atomically via Redis Lua; see §4.8 for script and key patterns.
- **SEC-003**: The reserved-slug list SHALL be enforced on every path that produces or accepts a slug (user proposal, admin slug_override, seed).

### Constraints

- **CON-001**: Tree depth is capped at 3 levels. Parent at level 3 SHALL NOT accept new children (the child would be level 4).
- **CON-002**: Slug length after normalization SHALL be 2–100 characters matching `^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$`.
- **CON-003**: Category rows SHALL NOT be hard-deleted. Archival (`status='archived'`) is the only deactivation path. Enforced by a `BEFORE DELETE` trigger.
- **CON-004**: Reparenting is forbidden. Enforced by a `BEFORE UPDATE` trigger on `parent_id`.
- **CON-005**: Rate limits:
  - `POST /categories/proposals`: 5 per user per 24 h + 20 per IP per 24 h
  - `POST /admin/categories/proposals/{id}/reject`: 30 per actor per hour
  - `GET /categories/proposals/mine`: 60 per user per minute
- **CON-006**: `statement_timeout` SHALL be set with `SET LOCAL statement_timeout = '5s'` within archive-cascade transactions. The `LOCAL` keyword is mandatory to prevent leakage into pooled connections.
- **CON-007**: Failed proposals (409/422) SHALL count against the per-user rate limit to block slug-probing enumeration.

### Guidelines

- **GUD-001**: Cache miss handlers on `GET /categories` SHALL use a single-flight pattern (Redis `SET NX EX` mutex) to prevent thundering herds after Redis recovery.
- **GUD-002**: Outbox and audit events SHALL be written in the same transaction as the triggering mutation; if either insert fails, the entire business operation fails.
- **GUD-003**: Admin tooling SHALL surface the server-computed slug to the proposer before submission so a predictable slug is expected.

### Patterns

- **PAT-001**: Transactional outbox for domain events (shared table defined in §4.2).
- **PAT-002**: PostgreSQL advisory transactional locks (`pg_advisory_xact_lock(1::int4, hashtext(...)::int4)`) scoped by namespace 1 for slug critical sections.
- **PAT-003**: Partial unique indexes scoped by status for slug uniqueness within each table; cross-table uniqueness enforced by a trigger (see §4.4).

## 4. Interfaces & Data Contracts

### 4.1 Physical Schema — `categories`

```sql
CREATE TABLE categories (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id      UUID        REFERENCES categories(id) ON DELETE RESTRICT,
  level          SMALLINT    NOT NULL CHECK (level BETWEEN 1 AND 3),
  name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  slug           TEXT        NOT NULL
                             CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$'),
  status         TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','archived')),
  creator_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  admin_created  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Slug globally unique among active categories.
CREATE UNIQUE INDEX uq_category_slug_active
  ON categories (slug)
  WHERE status = 'active';

-- Sibling name uniqueness (case-insensitive).
CREATE UNIQUE INDEX uq_category_name_sibling
  ON categories (
    LOWER(name),
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'active';

CREATE INDEX idx_categories_parent_active
  ON categories (parent_id)
  WHERE status = 'active';

-- Enforce level on INSERT based on parent.
CREATE OR REPLACE FUNCTION trg_check_category_level()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_level SMALLINT;
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
END;
$$;
CREATE TRIGGER check_category_level
  BEFORE INSERT ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_check_category_level();

-- Forbid reparenting.
CREATE OR REPLACE FUNCTION trg_deny_category_reparent()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'category_reparent_forbidden' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deny_category_reparent
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_deny_category_reparent();

-- Auto-maintain updated_at.
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER set_category_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Forbid hard deletes (archival-only).
CREATE OR REPLACE FUNCTION trg_deny_category_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'category_delete_forbidden' USING ERRCODE = 'P0005';
END;
$$;
CREATE TRIGGER deny_category_delete
  BEFORE DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_deny_category_delete();

-- Cross-table slug uniqueness: block INSERT into categories if a pending proposal
-- reserves the same slug. Closes the bypass on migrations/seeds/direct INSERTs.
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
END;
$$;
CREATE TRIGGER categories_pending_slug_check
  BEFORE INSERT ON categories
  FOR EACH ROW EXECUTE FUNCTION trg_categories_pending_slug_check();
```

### 4.2 Physical Schema — `category_proposals`

```sql
CREATE TABLE category_proposals (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  proposer_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  parent_category_id  UUID        NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  proposed_name       TEXT        NOT NULL CHECK (char_length(proposed_name) BETWEEN 2 AND 120),
  proposed_slug       TEXT        NOT NULL
                                  CHECK (proposed_slug ~ '^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$'),
  status              TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','approved','rejected','auto_rejected')),
  reviewed_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  rejection_code      TEXT        CHECK (rejection_code IN (
                                    'duplicate_category','max_depth_exceeded',
                                    'parent_archived','policy_violation',
                                    'proposer_deleted','admin_override'
                                  )),
  rejection_note      TEXT,
  auto_rejected       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proposals_status_created
  ON category_proposals (status, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_proposals_proposer
  ON category_proposals (proposer_id, created_at DESC)
  WHERE proposer_id IS NOT NULL;

CREATE UNIQUE INDEX uq_proposal_slug_pending
  ON category_proposals (proposed_slug)
  WHERE status = 'pending';
```

### 4.3 Physical Schema — `outbox_events` (shared infrastructure)

This table is defined here because it is first formally specified in this module; the Users & Authentication spec (PAT-002) retroactively references this definition.

```sql
CREATE TABLE outbox_events (
  id              BIGSERIAL   PRIMARY KEY,
  aggregate_type  TEXT        NOT NULL,       -- 'category', 'category_proposal', 'user', ...
  aggregate_id    UUID        NOT NULL,
  event_type      TEXT        NOT NULL,       -- 'category.approved', ...
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processed','failed')),
  attempt_count   SMALLINT    NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);

CREATE INDEX idx_outbox_pending_ready
  ON outbox_events (next_retry_at)
  WHERE status = 'pending';

CREATE INDEX idx_outbox_aggregate
  ON outbox_events (aggregate_type, aggregate_id);
```

- **Relay worker contract**: `SELECT ... WHERE status='pending' AND next_retry_at <= now() ORDER BY next_retry_at FOR UPDATE SKIP LOCKED LIMIT 100`. On success: `UPDATE ... SET status='processed', processed_at=now()`. On failure: `UPDATE ... SET attempt_count=attempt_count+1, last_error=$err, next_retry_at=now()+power(2,attempt_count)*interval '1 second'` (exponential backoff). When `attempt_count >= 5`: `status='failed'` and Prometheus alert fires.
- **Retention**: a scheduled job executes `DELETE FROM outbox_events WHERE status='processed' AND processed_at < now() - interval '7 days'` hourly. Rows in `status='failed'` are never auto-deleted and require manual triage.

### 4.4 Slug Normalization Pipeline

Applied in exact order. Identical pipeline is used in application code, seed scripts, and CI validation.

1. Unicode NFC normalization.
2. KMU-2010 Ukrainian Cyrillic → Latin transliteration. Full mapping:

   | Cyrillic | Latin | Cyrillic | Latin |
   |---|---|---|---|
   | а | a | н | n |
   | б | b | о | o |
   | в | v | п | p |
   | г | h | р | r |
   | ґ | g | с | s |
   | д | d | т | t |
   | е | e | у | u |
   | є | ie | ф | f |
   | ж | zh | х | kh |
   | з | z | ц | ts |
   | и | y | ч | ch |
   | і | i | ш | sh |
   | ї | i | щ | shch |
   | й | i | ь | *(dropped)* |
   | к | k | ю | iu |
   | л | l | я | ia |
   | м | m | ʼ / ' | *(dropped)* |

3. ICU ASCII folding for remaining non-ASCII Latin diacritics (e.g. `é → e`).
4. Lowercase (ASCII).
5. Replace `/[\s_]+/` with `-`.
6. Strip characters outside `[a-z0-9\-]`.
7. Collapse `/-{2,}/` to single `-`; trim leading/trailing `-`.
8. Truncate to 100 characters at a hyphen boundary (never mid-token).
9. Reserved-slug rejection. Reserved list:

   ```
   admin, api, categories, proposals, search, feed, listings, deals,
   reviews, users, me, static, cdn, auth, help, support, www, health,
   metrics, webhooks
   ```

A final regex assertion `^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$` MUST pass.

### 4.5 Concurrency Model

#### Proposal submission transaction

```text
BEGIN;
  -- Step 1: compute proposed_slug from proposed_name via pipeline (application layer).
  -- Step 2: validate parent exists, is active, and level < 3. Else 404/422.
  -- Step 3: acquire slug advisory lock:
  SELECT pg_advisory_xact_lock(1::int4, hashtext('proposal:slug:' || $slug)::int4);
  -- Step 4: verify no active category and no pending proposal holds the slug:
  SELECT 1 FROM categories WHERE slug = $slug AND status = 'active';
  SELECT 1 FROM category_proposals WHERE proposed_slug = $slug AND status = 'pending';
  -- If either found → ROLLBACK, return 409 duplicate_category.
  -- Step 5: INSERT INTO category_proposals ...
  -- Step 6: INSERT INTO outbox_events (category.proposed), audit_events (category.proposal.created).
COMMIT;
```

#### Approval transaction

```text
BEGIN;
  -- Step 1: acquire slug advisory lock on proposal's stored slug:
  SELECT pg_advisory_xact_lock(1::int4, hashtext('proposal:slug:' || $proposal_slug)::int4);
  -- Step 2: row-lock the target proposal:
  SELECT * FROM category_proposals WHERE id = $id AND status = 'pending' FOR UPDATE;
  -- If NOT FOUND → 409 proposal_not_pending.
  -- Step 3: resolve final_slug:
  --   if slug_override provided → validate (pipeline regex, reserved list) → final_slug = slug_override
  --   else → final_slug = proposed_slug
  -- Step 4: verify final_slug not taken by active category:
  SELECT 1 FROM categories WHERE slug = $final_slug AND status = 'active' FOR UPDATE;
  -- If FOUND → 409 duplicate_category.
  -- Step 5: auto-reject all OTHER pending proposals with same stored proposed_slug BEFORE inserting:
  UPDATE category_proposals
    SET status='auto_rejected', auto_rejected=TRUE,
        rejection_code='duplicate_category', reviewed_at=now(), reviewed_by=$admin_id
    WHERE proposed_slug = $proposal_slug AND status = 'pending' AND id <> $id;
  -- Step 6: INSERT INTO categories (level computed by trigger, creator_id = proposer_id).
  -- Step 7: UPDATE category_proposals SET status='approved', reviewed_by=$admin_id, reviewed_at=now() WHERE id=$id.
  -- Step 8: INSERT INTO outbox_events (category.approved + category.auto_rejected per race loser).
  -- Step 9: INSERT INTO audit_events (category.proposal.approved + category.proposal.auto_rejected per race loser).
COMMIT;
```

### 4.6 REST API

All endpoints are prefixed with `/api/v1`. All bodies are `application/json; charset=utf-8`.

| Method | Path | Auth | Rate limit | Purpose |
|--------|------|------|-----------|---------|
| GET | `/categories` | public | — | Full active tree (nested or flat) |
| GET | `/categories/proposals/mine` | access | 60/user/min | Proposer self-list |
| POST | `/categories/proposals` | access | 5/user/24h + 20/IP/24h | Submit proposal |
| GET | `/admin/categories/proposals` | admin, moderator | — | Admin pending list |
| POST | `/admin/categories/proposals/{id}/approve` | admin | — | Approve; accepts `slug_override` |
| POST | `/admin/categories/proposals/{id}/reject` | admin, moderator | 30/actor/h | Reject |
| POST | `/admin/categories` | admin | — | Direct create (root or child); accepts `slug_override` |
| POST | `/admin/categories/{id}/archive` | admin | — | Archive; `cascade` flag |
| PATCH | `/admin/categories/{id}` | admin | — | Edit `name`; `slug` is immutable |

#### 4.6.1 GET /categories

Query: `format=nested` (default) or `format=flat`. 200 OK returns:

```json
{
  "tree": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "slug": "tekhnolohii",
      "name": "Технології",
      "level": 1,
      "children": [
        { "id": "...", "slug": "mobilna-rozrobka", "name": "Мобільна розробка", "level": 2, "children": [] }
      ]
    }
  ],
  "cached_at": "2026-04-18T10:00:00Z"
}
```

#### 4.6.2 POST /categories/proposals

```json
{
  "parent_category_id": "22222222-2222-2222-2222-222222222222",
  "proposed_name": "Мобільна розробка"
}
```

201 Created returns the created proposal including the server-computed `proposed_slug`. Errors use the code table in §4.7.

#### 4.6.3 GET /categories/proposals/mine

Query: `status=pending|approved|rejected|auto_rejected|all` (default `all`), `limit`, `cursor` (opaque base64). 200 OK returns an array of the caller's proposals plus `next_cursor` and `has_more`. Rate-limited at 60/min/user.

#### 4.6.4 POST /admin/categories/proposals/{id}/approve

```json
{ "slug_override": "inshe-design", "note": "Approved with manual disambiguation." }
```

`slug_override` is optional. If present, it is validated against the pipeline regex and reserved list; if invalid, 422 `invalid_slug_override`.

#### 4.6.5 POST /admin/categories

Admin direct create (root or child):

```json
{ "name": "Інше", "parent_id": "...", "slug_override": "inshe-design" }
```

`parent_id=null` produces a level-1 root.

#### 4.6.6 POST /admin/categories/{id}/archive

```json
{ "cascade": false }
```

Pre-flight recursive CTE counts active descendants. If count ≤ 20, archival proceeds synchronously inside a transaction that begins with `SET LOCAL statement_timeout = '5s'`. If count > 20, a 202 Accepted response returns `{ "job_id": "...", "status": "queued", "poll_url": "..." }` and the cascade runs as an async job. All pending proposals targeting any archived category are auto-rejected with `rejection_code='parent_archived'` in the same transaction (sync path) or within the job (async path).

### 4.7 Error Codes

| Code | HTTP | Triggering condition |
|------|------|---------------------|
| `duplicate_category` | 409 | Slug (computed or override) already held by an active category or pending proposal |
| `max_depth_exceeded` | 422 | Parent is already at level 3 |
| `parent_not_found` | 404 | `parent_id` does not exist |
| `parent_archived` | 422 | Parent is archived |
| `root_proposal_forbidden` | 422 | User submits proposal without `parent_category_id` |
| `invalid_slug_override` | 422 | `slug_override` fails regex or reserved check |
| `rate_limit_exceeded` | 429 | Per-user, per-IP, or per-actor limit hit |
| `proposal_not_pending` | 409 | Approve/reject invoked on non-pending proposal |

### 4.8 Rate Limiting — Atomic Redis Lua

```lua
-- KEYS[1]: rate limit key
-- ARGV[1]: max allowed count
-- ARGV[2]: window TTL in seconds
-- Returns: { current_count, allowed (1|0) }
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then
  return { tonumber(current), 0 }
end
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return { n, 1 }
```

Key patterns:

```
rl:propose:user:{user_id}:{YYYYMMDD}         TTL 86400
rl:propose:ip:{ip_hash}:{YYYYMMDD}           TTL 86400
rl:reject:actor:{user_id}:{YYYYMMDDHH}       TTL 3600
rl:mine:user:{user_id}:{YYYYMMDDHHmm}        TTL 60
```

### 4.9 Caching

- Key: `categories:tree:v1`. Value: gzip-compressed JSON of nested active tree. TTL: 50 seconds.
- Invalidation: post-commit synchronous Redis `DEL` in the request path of approve, reject, archive, admin-create, and name-edit endpoints. DEL failure is logged to `category_cache_del_failures_total` and does not block the response.
- **Single-flight rebuild**: cache misses acquire a short Redis mutex `categories:tree:lock` via `SET NX EX 5`. Requests that fail to acquire the mutex wait up to 2 s polling for the key; if still absent, they fall through to a direct DB read without caching. This prevents thundering-herd DB load after Redis recovery or long outages.
- Listing creation validates `category_id` against the primary database (not cache), guaranteeing approved-to-selectable latency equals commit latency (~10 ms), satisfying AC-014 independently of cache state.

### 4.10 AuthZ Matrix

| Action | client | provider | moderator | admin |
|--------|:---:|:---:|:---:|:---:|
| Propose | ✓ | ✓ | ✓ | ✓ |
| View own proposals | ✓ | ✓ | ✓ | ✓ |
| Admin pending list | — | — | ✓ | ✓ |
| Approve | — | — | — | ✓ |
| Reject | — | — | ✓ | ✓ |
| Archive | — | — | — | ✓ |
| Admin create | — | — | — | ✓ |
| Edit name | — | — | — | ✓ |

All write actions re-read the actor's role from `user_roles` joined with `users WHERE status='active'` per SEC-001.

### 4.11 Audit and Domain Events

Two separate streams are written in the same transaction as the triggering mutation.

**Domain events (`outbox_events`)** — consumed by Feed, Search, Notifications:

| event_type | aggregate_type | Trigger |
|-----------|----------------|---------|
| `category.proposed` | `category_proposal` | POST /proposals commit |
| `category.approved` | `category` | Approval commit |
| `category.rejected` | `category_proposal` | Reject commit |
| `category.auto_rejected` | `category_proposal` | Approval commit (race loser) OR proposer soft-delete |
| `category.archived` | `category` | Archive commit |
| `category.admin_created` | `category` | Admin direct create |
| `category.name_edited` | `category` | Name edit commit |

**Audit events (`audit_events`)** — append-only compliance log:

For each category write, a row is appended populating **all** of `actor_user_id`, `target_user_id` (where applicable), `event_type`, `metadata JSONB`, `ip`, and `user_agent`. The admin's request context (IP and User-Agent header) MUST be forwarded to the audit write for regulatory traceability.

| event_type | actor | target | metadata |
|------------|-------|--------|---------|
| `category.proposal.created` | proposer | — | `{proposal_id, proposed_name, proposed_slug, parent_id}` |
| `category.proposal.approved` | admin | proposer | `{proposal_id, category_id, final_slug, slug_overridden}` |
| `category.proposal.rejected` | admin/mod | proposer | `{proposal_id, rejection_code, rejection_note}` |
| `category.proposal.auto_rejected` | admin/system | proposer | `{proposal_id, winner_proposal_id OR trigger='proposer_deleted'}` |
| `category.archived` | admin | — | `{category_id, cascade, archived_descendants}` |
| `category.admin_created` | admin | — | `{category_id, slug, parent_id, level}` |
| `category.name_edited` | admin | — | `{category_id, old_name, new_name}` |

### 4.12 GDPR Erasure Contract

The Users & Authentication spec owns the soft-delete flow (AC-009). On user soft-delete, the Auth service emits a `user.soft_deleted` domain event to `outbox_events`. The Categories service subscribes to this event and, within a single transaction:

```sql
UPDATE category_proposals
  SET status='auto_rejected', auto_rejected=TRUE,
      rejection_code='proposer_deleted', reviewed_at=now()
  WHERE proposer_id = $deleted_user_id AND status = 'pending';

-- Emit category.auto_rejected domain event per affected proposal.
-- Emit category.proposal.auto_rejected audit event per affected proposal.
```

At the 90-day hard-purge (Auth AC-009), the `users` row is deleted. FK `ON DELETE SET NULL` on `proposer_id`, `reviewed_by`, and `categories.creator_id` preserves historical rows with NULLed identity references.

### 4.13 Cross-Module Requirements

- **CROSS-001 [Categories → Listings]**: The future `spec-process-listing-lifecycle.md` SHALL include a `BEFORE INSERT` trigger on `listings` that rejects rows whose `category_id` is not present in `categories WHERE status='active'` with SQLSTATE `P0004` (`category_not_active`). The Listings service SHALL catch SQLSTATE `P0004` and return HTTP 422 with `{"error":{"code":"category_not_active"}}`. An integration test in the Listings test suite SHALL verify the trigger exists and fires.
- **CROSS-002 [Auth → Categories]**: The Users & Authentication spec (PAT-002) uses the `outbox_events` table defined in §4.3 of this spec. A `user.soft_deleted` outbox event SHALL be emitted on every user soft-delete for Categories (and other modules) to consume.

## 5. Acceptance Criteria

- **AC-001**: Given a registered user, When `POST /categories/proposals` is called with a valid `parent_category_id` and a `proposed_name` that normalizes to a free slug, Then a `category_proposals` row is created with `status='pending'` and the computed slug is returned in the response body.
- **AC-002**: Given an active category or a pending proposal already holds the computed slug, When a second proposal is submitted, Then the response is `409 Conflict` with `code='duplicate_category'` and NO `category_proposals` row is inserted.
- **AC-003**: Given a parent category at level 3, When a proposal is submitted under it, Then the response is `422 Unprocessable Entity` with `code='max_depth_exceeded'`.
- **AC-004**: Given an admin approves a pending proposal without `slug_override`, When the transaction commits, Then a `categories` row exists with `slug` equal to the proposal's `proposed_slug`, AND all other `pending` proposals with the same `proposed_slug` are flipped to `auto_rejected` with `rejection_code='duplicate_category'`, AND the change is observable via `GET /categories` within 60 seconds.
- **AC-005**: Given an admin approves with `slug_override`, When the override is valid and free, Then the created category uses the override slug and all race-loser proposals are auto-rejected as in AC-004.
- **AC-006**: Given a moderator (role `moderator`), When they invoke `POST /admin/categories/proposals/{id}/approve`, Then the response is `403 Forbidden`.
- **AC-007**: Given a moderator rejects 30 proposals within one hour, When the 31st reject is attempted, Then the response is `429 Too Many Requests` with `code='rate_limit_exceeded'`.
- **AC-008**: Given a user has 5 pending proposals created within the last 24 hours, When the 6th proposal is submitted, Then the response is `429` regardless of whether the computed slug would be valid.
- **AC-009**: Given a category is archived with `cascade=false` and has active children, When the endpoint is called, Then the response is `409 Conflict` with `code='has_active_children'` and no rows are modified.
- **AC-010**: Given a category is archived with `cascade=true` and has ≤20 active descendants, When archival commits, Then all descendants are marked `archived`, all pending proposals targeting any of those categories are marked `auto_rejected` with `rejection_code='parent_archived'`, and the transaction completes within 5 seconds.
- **AC-011**: Given a category has been archived, When `POST /listings` (future endpoint) is attempted with that category's id, Then the BEFORE INSERT trigger defined in CROSS-001 raises `P0004` and the API returns `422 category_not_active`.
- **AC-012**: Given a pending proposal authored by user U, When U is soft-deleted, Then the Categories service (consuming `user.soft_deleted` from outbox) marks the proposal `auto_rejected` with `rejection_code='proposer_deleted'` within 60 seconds and emits `category.auto_rejected`.
- **AC-013**: Given an attempt to execute `DELETE FROM categories WHERE id = ...`, When the statement runs, Then it aborts with SQLSTATE `P0005` (`category_delete_forbidden`).
- **AC-014**: Given an attempt to execute `UPDATE categories SET parent_id = ...`, When the statement runs on an existing row with a different `parent_id`, Then it aborts with SQLSTATE `P0001` (`category_reparent_forbidden`).
- **AC-015**: Given Redis is unavailable, When `GET /categories` is requested, Then the application falls back to a direct DB read under single-flight lock and responds without 5xx.
- **AC-016**: Given an `outbox_events` row has failed 5 delivery attempts, When the 6th attempt fails, Then the row's `status` transitions to `failed` and the `outbox_failed_events_total` Prometheus counter is incremented.

## 6. Test Automation Strategy

- **Test levels**: unit (normalization pipeline, permission matrix), integration (all endpoints against real Postgres + Redis, trigger coverage), end-to-end (propose → approve → GET /categories observes new node within 60 s), property-based (concurrency: parallel proposals for the same normalized name).
- **Test data management**: per-test schema via transactional rollback OR ephemeral Postgres container per suite; Redis flushed between tests; no shared mutable fixtures.
- **CI/CD**: all levels run on every PR. Seed idempotency suite (§9.2) runs nightly and on migration changes.
- **Coverage**: ≥ 90 % line coverage for the `categories` and `proposals` packages; 100 % branch coverage for the slug normalization pipeline and the approval transaction.
- **Performance**: `POST /categories/proposals` SHALL sustain 200 RPS at p95 ≤ 400 ms. `GET /categories` SHALL sustain 2000 RPS at p95 ≤ 100 ms (cached path) and 500 RPS at p95 ≤ 250 ms (cold cache single-flight path).
- **Security tests**: slug-probing enumeration (rate limit must trigger), moderator bulk-reject (reject rate limit must trigger), `alg=none` JWT on admin endpoints (must be rejected per Auth SEC-005).

## 7. Rationale & Context

- **Adjacency list with explicit `level`** over closure table / ltree: the tree is capped at 3 levels and will contain at most hundreds of rows at MVP scale. Closure tables and ltree add operational complexity for query patterns that never arise at depth 3.
- **`level` 1..3 over `depth` 0..2**: aligns with the umbrella spec's natural-language "depth (1–3)" and AC-013 "level 3". Using 1-based values eliminates the risk of off-by-one misimplementation of the `max_depth_exceeded` check.
- **Global slug uniqueness across active + pending** (HYBRID with admin `slug_override`): preserves flat, unambiguous URL routing (`/categories/{slug}`) while providing the escape hatch admins need for homograph collisions ("Інше" under multiple roots) and KMU-2010 ambiguities (и/і both map to Latin `i` is a false claim — KMU-2010 maps и→y). The `slug_override` is admin-only to prevent user gaming of the slug namespace.
- **Cross-table slug uniqueness via trigger on `categories` INSERT**: the advisory-lock + re-check pattern in the proposal and approval transactions is sufficient for normal paths, but seeds, migrations, and out-of-band data fixes bypass application code. A database trigger closes this gap regardless of caller.
- **Post-commit synchronous cache DEL (not outbox-relay)**: outbox relay introduces unbounded lag (poll interval + processing). AC-014's 60 s window requires a deterministic upper bound; DEL in the request path plus 50 s TTL fallback gives ~45 ms normal and ≤50 s worst-case, well within AC-014.
- **Single-flight rebuild mutex**: after Redis recovery, the natural alternative (let every request rebuild) produces a thundering herd on a recursive-CTE query. A 5-second SET NX lock bounds concurrent rebuilds to one.
- **Moderator rejects only, admins approve**: approval creates platform state affecting every user; rejection is low-consequence triage. This matches the Users & Authentication role model's principle of least privilege and is consistent with SEC-001 DB re-read.
- **Outbox retry counter + exponential backoff**: without `attempt_count` and `next_retry_at`, the relay worker cannot distinguish "retry this" from "alert on this" — the at-least-once guarantee becomes unenforceable in practice.
- **`ON DELETE SET NULL` for `proposer_id`, `reviewed_by`, `creator_id`**: GDPR erasure preserves the audit trail while removing PII references.

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: Users service (this platform) — provides `users` and `user_roles` tables referenced by foreign keys; emits `user.soft_deleted` outbox events consumed by this module.

### Third-Party Services

- **SVC-001**: None specific to this module. (CDN, email, and notification services are consumers of `category.*` events but are not required by this module itself.)

### Infrastructure Dependencies

- **INF-001**: PostgreSQL 15+ — primary store for categories, proposals, outbox, audit. Required features: partial unique indexes, triggers in PL/pgSQL, `pg_advisory_xact_lock`, `gen_random_uuid()`, JSONB.
- **INF-002**: Redis 2.6+ — rate-limit counters, tree cache, single-flight rebuild mutex. Required features: `EVAL`/`EVALSHA` Lua scripting, `SET NX EX`.
- **INF-003**: Background job runner — executes async archival for subtrees > 20 nodes and the hourly `outbox_events` retention sweep. Shared infrastructure, specification TBD.
- **INF-004**: Prometheus + Alertmanager — metrics and alerting. Required metrics: `category_proposals_total{status}`, `category_proposals_pending_count`, `category_cache_del_failures_total`, `outbox_failed_events_total`.

### Data Dependencies

- **DAT-001**: Seed file `seeds/categories.sql` — committed to source control with stable UUIDs; defines the editorial root and anchor categories. Idempotent via `ON CONFLICT (id) DO NOTHING`. Transactional (BEGIN/COMMIT).

### Technology Platform Dependencies

- **PLT-001**: KMU-2010 transliteration library or a self-contained implementation of the mapping table in §4.4 step 2. Implementation SHALL be identical across application code, seed validators, and CI assertions.

### Compliance Dependencies

- **COM-001**: GDPR — proposer data is erasable via the FK `ON DELETE SET NULL` pattern and the soft-delete auto-reject flow in §4.12. Cross-references Users & Authentication AC-009 and COM-001.

## 9. Examples & Edge Cases

### 9.1 Normalization Examples

```
"Ремонт побутової техніки"        → remont-pobutovoi-tekhniky
"Ремонт побутової техніки "       → remont-pobutovoi-tekhniky   (trailing space stripped; hits duplicate_category)
"Інше"                             → inshe                        (may collide across roots; admin uses slug_override)
"café"                             → cafe                         (ICU fold)
"И-варіанти"                       → y-varianty                   (KMU-2010 и→y)
"Йогурти"                          → iohurty                      (й→i at start, treated as vowel context)
"admin"                            → rejected: reserved_slug
"Ремонт 2020"                      → remont-2020                  (digits preserved)
```

### 9.2 Seed Idempotency Test Matrix

| Scenario | Expected outcome |
|----------|------------------|
| Empty DB, run seed once | N rows inserted, 0 errors |
| Already-seeded DB, run seed again | 0 rows inserted (ON CONFLICT (id) DO NOTHING), 0 errors |
| Seeded DB with a user-created active category whose slug collides with a seed row's slug | Seed transaction aborts with SQLSTATE 23505 (slug unique violation) OR P0006 (pending slug conflict); CI test MUST fail loudly. Recovery requires admin to rename the conflicting user category. DO NOT add `ON CONFLICT (slug) DO NOTHING` as a "fix" — silent skipping leaves the platform without a required root category. |

### 9.3 Race: Concurrent Approvals of Same-Slug Proposals

```text
Given: proposals P1 and P2 both have proposed_slug='remont-kondytsioneriv', both pending.
When:  Admin A approves P1 and Admin B approves P2 concurrently.
Then:  Advisory lock (1, hashtext('proposal:slug:remont-kondytsioneriv')) serializes.
       Winner (say P1) inserts the category, auto-rejects P2 with 'duplicate_category'.
       Loser's approval transaction reads P2 as no-longer-pending → 409 proposal_not_pending.
       No constraint violations surface as 5xx.
```

### 9.4 Race: Direct INSERT into categories while Proposal Pending

```text
Given: category_proposals has proposed_slug='robota-na-domu' in status='pending'.
When:  Migration script runs: INSERT INTO categories (slug='robota-na-domu', ...);
Then:  trg_categories_pending_slug_check raises P0006 duplicate_category.
       Migration aborts; manual reconciliation required.
```

### 9.5 Seed File (Excerpt)

```sql
BEGIN;
INSERT INTO categories (id, parent_id, level, name, slug, status, admin_created, creator_id)
VALUES
  ('11111111-1111-1111-1111-111111111111', NULL, 1,
   'Технології', 'tekhnolohii', 'active', TRUE, NULL),
  ('22222222-2222-2222-2222-222222222222', NULL, 1,
   'Дизайн', 'dyzain', 'active', TRUE, NULL),
  ('33333333-3333-3333-3333-333333333333',
   '11111111-1111-1111-1111-111111111111', 2,
   'Мобільна розробка', 'mobilna-rozrobka', 'active', TRUE, NULL)
ON CONFLICT (id) DO NOTHING;
COMMIT;
```

Note: `level` is supplied explicitly so the seed works even if the `trg_check_category_level` trigger is temporarily disabled during a migration. A CI test SHALL verify each seed row's `level` is consistent with the trigger-computed value.

## 10. Validation Criteria

A compliant implementation SHALL pass all of the following:

1. Every endpoint in §4.6 exists at the specified path and returns the documented status codes.
2. All acceptance criteria AC-001 through AC-016 pass as automated integration tests.
3. Every database trigger listed in §4.1 exists and fires; negative tests verify SQLSTATEs `P0001`–`P0006` are raised for the documented conditions.
4. The slug normalization pipeline produces the outputs in §9.1 for each listed input. A property-based test verifies idempotency: `normalize(normalize(s)) == normalize(s)`.
5. Concurrency test: 50 parallel `POST /categories/proposals` with the same `proposed_name` result in exactly one `status='pending'` row; all others receive `409 duplicate_category`.
6. Concurrency test: 10 parallel approvals of proposals sharing a slug produce exactly one `categories` row; all others either 409 `proposal_not_pending` or 409 `duplicate_category`.
7. Cache test: after an approval commits, `GET /categories` shows the new category on the next uncached read; under Redis outage, the single-flight fallback returns a valid response.
8. GDPR test: soft-deleting a user with 3 pending proposals results in 3 `auto_rejected` rows with `rejection_code='proposer_deleted'` within 60 seconds and 3 `category.auto_rejected` outbox events.
9. Seed idempotency suite passes the three scenarios in §9.2.
10. Load test: `GET /categories` sustains 2000 RPS at p95 ≤ 100 ms on the cached path.
11. Audit completeness: every endpoint in §4.6 that produces a mutation writes the corresponding audit event per §4.11 including non-null `ip` and `user_agent`.

## 11. Related Specifications / Further Reading

- [`spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — role model (`client`, `provider`, `admin`, `moderator`), SEC-006 DB re-read, `audit_events` schema, soft-delete AC-009.
- [`spec-architecture-marketplace-social-platform.md`](./spec-architecture-marketplace-social-platform.md) — REQ-015, CON-005, AC-012/013/014 (umbrella constraints this spec implements).
- `spec-process-listing-lifecycle.md` *(to be created)* — consumer of CROSS-001; implements the `BEFORE INSERT` trigger rejecting non-active `category_id`.
- `spec-infrastructure-outbox-relay.md` *(to be created)* — relay worker operational details, retry policy, alerting.
- Cabinet of Ministers of Ukraine Resolution No. 55 (2010-01-27) — KMU-2010 transliteration standard.
- PostgreSQL documentation — advisory locks, partial indexes, PL/pgSQL triggers.
