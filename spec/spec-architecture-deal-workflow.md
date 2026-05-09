---
title: Deal Workflow (BIZ-001)
version: 1.3
date_created: 2026-05-06
last_updated: 2026-05-09
owner: Platform / Backend Team
tags: [architecture, deals, state-machine, escrow, marketplace]
---

# Introduction

This specification defines the Deal Workflow module of the Robotun freelance marketplace: state machine, data model, REST API, authorization, escrow event interface, concurrency model, SLA timers, and audit log. A Deal represents a contractual engagement between a Client and a Provider for a single service. The platform mediates state transitions, holds escrow via an external Payments module (CON-005), and resolves disputes via Admin action.

The spec is the synthesis of an `architect` × `critic` orchestration loop: 23 final DECISIONs across 3 architect rounds and 2 critic rounds, with all flagged risks resolved or formally accepted as residual.

## 1. Purpose & Scope

**In scope**

- Deal entity schema, audit log (`deal_events`), attachments (`deal_attachments`), dispute escalation queue (`dispute_escalations`).
- State machine: `pending → active → in_review → completed | disputed | cancelled`.
- REST API: deal CRUD, state transitions, attachments, event log read.
- Authorization matrix and field-level mutability rules per state.
- Escrow event interface (outbox-based, async): hold request, hold confirmation callback, release, refund, partial release.
- Optimistic concurrency, idempotency, and timer correctness contracts.
- SLA timers: pending accept timeout, in_review auto-complete, dispute resolution SLA, cancel consent window, escrow hold timeout, post-auto-complete dispute grace.
- Compensating timers and double-firing prevention.
- PII projection on event reads.
- Account lifecycle interaction (suspension, role revocation, soft-delete) with open deals.

**Out of scope**

- Payments / escrow implementation. The Payments module is a CON-002 stub at MVP; this spec defines only the event contract.
- KYC enforcement at deal time. Per established project decision, KYC gates payout, not deal creation.
- Multi-milestone deals. `deals` is single-stage in v1; `deal_milestones` is an additive future table.
- Review module. `deal.approved` / `deal.auto_completed` events unlock review eligibility; the Review spec is separate.
- Notifications delivery. Outbox events are consumed by a separate Notifications module.
- Dispute admin UI / senior admin queue UI. This spec defines the data contract (`dispute_escalations`) only.
- Deal amendments after acceptance (price/scope changes). Future `deal_amendments` workflow.
- Listing → deal funnel UX. The optional `listing_id` FK is included; UX is owned by Listings.
- Currencies other than UAH. The `currency` column with CHECK constraint is the extension point.
- Four-eyes rule for high-value dispute resolutions. Schema accommodates via nullable `approved_by_admin_id` in v1.1.
- Mutual TLS for internal callback. Service-account JWT (RS256) is sufficient at MVP; mTLS deferred.
- Outbox routing of `deal.transition_rejected` events. v1 uses Prometheus counter on separate-tx failure; outbox routing deferred to v1.1.

**Audience:** backend engineers, platform/data engineers, security reviewers, QA, AI code-generation agents producing DDL and service code.

## 2. Definitions

| Term | Definition |
|------|------------|
| Deal | A contractual engagement between one Client and one Provider for a single service exchange, tracked as a row in `deals`. |
| Client | The party who initiates the deal and pays for the service. Deal-time role; a single `users` row may act as Client on one deal and Provider on another. |
| Provider | The party who accepts the deal and delivers the service. |
| Escrow | Funds held by the Payments module after Client commits, released to Provider on completion or refunded on cancellation. The Deal module does NOT hold funds itself. |
| Outbox | Transactional outbox table `outbox_events` (defined in the Category Tree spec) used for at-least-once delivery of domain events to downstream consumers. |
| Optimistic lock | The `deals.version` integer column, incremented on every state-mutating UPDATE; used in WHERE clauses to detect concurrent modification. |
| Idempotency key | A client-supplied UUID accompanying `POST /deals` to enable safe retries. |
| Auto-complete | System transition from `in_review` to `completed` when the Client does not act within the review window. |
| Dispute window | The period during which the Client may open a dispute. Extends `auto_complete_after` by 24 hours (grace period). |
| SEC-006 | Auth-spec requirement that high-impact mutations re-read the actor's role from the primary DB rather than trusting JWT claims alone. |
| INF-003 | Auth-spec infrastructure decision establishing the RS256 key-management infrastructure reused for service-account JWTs. |
| Service account | A `users` row with role `payments_service` used by the Payments module to authenticate to the internal escrow callback endpoint. |
| Terminal state | A deal status from which no further transitions are legal: `completed` or `cancelled`. |
| BIZ-001 | This module's identifier in the umbrella spec. |

## 3. Requirements, Constraints & Guidelines

### Functional Requirements

- **REQ-001**: The system SHALL persist each deal as a single row in `deals` with `status` constrained to `{pending, active, in_review, completed, disputed, cancelled}`.
- **REQ-002**: A Client SHALL initiate a deal via `POST /deals`. The deal SHALL be created in `status='pending'`.
- **REQ-003**: A Provider SHALL accept a pending deal via `POST /deals/{id}/accept`. Acceptance SHALL NOT directly transition status to `active`; instead it SHALL set `escrow_status='hold_requested'` and emit `deal.escrow_hold_requested` to the outbox.
- **REQ-004**: The Payments module SHALL confirm escrow placement via `POST /internal/deals/{id}/escrow-held`. On successful callback, the deal SHALL atomically transition `pending → active` and `escrow_status → held`.
- **REQ-005**: A Provider SHALL submit work for review via `POST /deals/{id}/submit`, transitioning `active → in_review`.
- **REQ-006**: A Client SHALL approve work via `POST /deals/{id}/approve`, transitioning `in_review → completed`.
- **REQ-007**: A Client SHALL open a dispute via `POST /deals/{id}/dispute` from `in_review`, OR within the 24-hour grace period after auto-complete (transitioning `completed → disputed` if `escrow_release_requested_at IS NULL`).
- **REQ-008**: An Admin SHALL resolve a disputed deal via `POST /deals/{id}/resolve` with a typed outcome (`release_to_provider | refund_to_client | split`).
- **REQ-009**: Cancellation from `active` SHALL require mutual consent: both parties record a `cancel_request`, otherwise the request lapses after 48 hours.
- **REQ-010**: All state-mutating endpoints SHALL accept and validate the deal's current `version` for optimistic concurrency control.
- **REQ-011**: `POST /deals` SHALL require an `Idempotency-Key` header and SHALL return the original deal on replay with the same body, or 409 on body mismatch.
- **REQ-012**: Every state transition SHALL append a row to `deal_events` in the same transaction as the deal mutation.
- **REQ-013**: Every escrow-relevant state transition SHALL emit a typed event to `outbox_events` in the same transaction.
- **REQ-014**: The system SHALL run a polling timer worker (60-second interval) that auto-transitions deals at expired timers and emits the corresponding events.
- **REQ-015**: Auto-complete from `in_review` SHALL NOT immediately emit `deal.escrow_release_requested`. A separate sweep SHALL emit the release event only after `dispute_window_until <= now()` (24 hours after auto-complete).
- **REQ-016**: `GET /deals/{id}/events` SHALL return a per-event-type-projected metadata view to non-admin callers, stripping `ip`, `user_agent`, and metadata keys not on the per-event-type whitelist.

### Security Requirements

- **SEC-001**: Admin-role mutations (`/resolve`, admin `/cancel`) SHALL re-read the actor's role from `user_roles` against the primary DB and SHALL NOT rely on JWT claims alone (per SEC-006 of the Auth spec).
- **SEC-002**: `POST /internal/deals/{id}/escrow-held` SHALL authenticate the caller via an RS256 JWT whose `roles` claim contains `payments_service` AND SHALL re-read the role from `user_roles` against the primary DB. Network isolation is defence-in-depth, not the primary trust boundary.
- **SEC-003**: `GET /deals/{id}/events` SHALL strip `ip` and `user_agent` from every event row returned to non-admin callers.
- **SEC-004**: `GET /deals/{id}/events` SHALL filter `metadata` JSONB keys to a per-event-type whitelist (§4.7) for non-admin callers. Keys not on the whitelist SHALL be excluded.
- **SEC-005**: `POST /deals/{id}/dispute` SHALL require a `reason` string of minimum 30 characters and at least one `attachment_id` referencing an attachment uploaded by the disputing party against the same deal.

### Constraints

- **CON-001**: A deal SHALL have `client_id <> provider_id` (DB CHECK).
- **CON-002**: Money is stored as integer minor units (UAH kopecks) in `BIGINT` columns. `agreed_price > 0` (DB CHECK).
- **CON-003**: Currency is fixed to `UAH` in v1 (DB CHECK).
- **CON-004**: All timestamps are `TIMESTAMPTZ`. SLA computations are performed inside the DB transaction using `now() + interval '...'`; the application layer SHALL NOT pass computed timestamps for SLA fields.
- **CON-005**: The platform does NOT process payments at MVP (umbrella CON-002). Escrow is an event-based interface contract only.
- **CON-006**: KYC status is NOT checked at deal creation or acceptance. KYC enforcement is the Payments module's responsibility at the payout step.
- **CON-007**: Terminal states (`completed`, `cancelled`) SHALL NOT accept further transitions. Once `resolved_at` is set on a disputed deal that resolved to `completed` or `cancelled`, attachments and state mutations SHALL be rejected with 409 `deal_terminal_state`.
- **CON-008**: `deal_events` is a plain unpartitioned table in v1. Partitioning is deferred until the table exceeds ~10M rows OR a time-range compliance access pattern emerges.
- **CON-009**: `idempotency_key` rows on `deals` are permanently retained. No TTL.
- **CON-010**: Cancellation columns `cancel_requested_by_client_at` and `cancel_requested_by_provider_at` SHALL only be non-null when `status IN ('active', 'cancelled')` (DB CHECK).

### Guidelines

- **GUD-001**: Application code SHOULD prefer single `UPDATE ... WHERE version=$v AND status=$expected RETURNING` statements over read-modify-write loops to eliminate TOCTOU windows.
- **GUD-002**: Timer worker SHOULD use `FOR UPDATE SKIP LOCKED` on the candidate scan and SHOULD include the timer-condition predicate in the UPDATE WHERE clause for idempotency.
- **GUD-003**: Outbox event consumers SHOULD treat `deal.escrow_*` events as authoritative for escrow state changes; the Deal service is NOT a system of record for escrow funds.
- **GUD-004**: SLA values (72h, 7d, 14d, 24h grace, 48h consent) SHOULD be reviewed by qualified Ukrainian consumer-protection legal counsel before production launch.

### Patterns

- **PAT-001**: Optimistic locking pattern — every transition UPDATE includes `WHERE id=$id AND version=$v AND status=$expected`. RowCount=0 distinguished into `version_conflict` (409) vs `status_conflict` (409) by re-read.
- **PAT-002**: Idempotent timer pattern — UPDATE includes the timer condition (`auto_complete_after <= now()` or equivalent); zero rows returned = silent no-op, no event emitted.
- **PAT-003**: Atomic mutual-cancel pattern — single `UPDATE ... RETURNING` with CASE expressions sets the caller's column AND conditionally transitions to `cancelled` if the other party's column is already non-null.
- **PAT-004**: SEC-006 admin re-read — every admin-role mutation does `SELECT 1 FROM user_roles JOIN users WHERE user_id=$sub AND role='admin' AND users.status='active'` before processing.

## 4. Interfaces & Data Contracts

### 4.1 Core schema

```sql
CREATE TABLE deals (
  id                            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                     UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id                   UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  listing_id                    UUID         REFERENCES listings(id) ON DELETE SET NULL,
  category_id                   UUID         NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,

  title                         VARCHAR(200) NOT NULL,
  description                   TEXT         NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),

  status                        TEXT         NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','active','in_review','completed','disputed','cancelled')),

  agreed_price                  BIGINT       NOT NULL CHECK (agreed_price > 0),  -- UAH kopecks
  currency                      CHAR(3)      NOT NULL DEFAULT 'UAH' CHECK (currency = 'UAH'),

  -- Escrow lifecycle
  escrow_status                 TEXT         NOT NULL DEFAULT 'not_required'
                                  CHECK (escrow_status IN (
                                    'not_required','hold_requested','held',
                                    'release_requested','released',
                                    'refund_requested','refunded'
                                  )),
  escrow_hold_id                UUID,
  escrow_hold_requested_at      TIMESTAMPTZ,
  escrow_held_at                TIMESTAMPTZ,
  escrow_release_requested_at   TIMESTAMPTZ,  -- gates completed→disputed rollback
  escrow_released_at            TIMESTAMPTZ,
  escrow_refunded_at            TIMESTAMPTZ,
  escrow_hold_cap_reached       BOOLEAN      NOT NULL DEFAULT false,                         -- v1.2: PSP signals cap via /internal callback

  -- Scheduling
  deadline_at                   TIMESTAMPTZ,

  -- SLA timers (set inside DB transactions on transitions)
  review_started_at             TIMESTAMPTZ,
  auto_complete_after           TIMESTAMPTZ,
  dispute_window_until          TIMESTAMPTZ,  -- auto_complete_after + 24h
  dispute_opened_at             TIMESTAMPTZ,
  dispute_resolve_by            TIMESTAMPTZ,
  dispute_escalation_count      INT          NOT NULL DEFAULT 0,

  -- Cancel consent
  cancel_requested_by_client_at   TIMESTAMPTZ,
  cancel_requested_by_provider_at TIMESTAMPTZ,
  cancellation_reason           TEXT
                                  CHECK (cancellation_reason IS NULL OR cancellation_reason IN (
                                    'escrow_timeout',
                                    'dispute_unresolved',
                                    'provider_suspended',
                                    'escrow_hold_expired'                                    -- v1.2
                                  )),

  -- Dispute resolution
  resolution_outcome            TEXT
                                  CHECK (resolution_outcome IN ('release_to_provider','refund_to_client','split')),
  resolution_release_amount     BIGINT,
  resolution_note               TEXT,
  resolved_by_admin_id          UUID         REFERENCES users(id),
  resolved_at                   TIMESTAMPTZ,

  -- Concurrency / idempotency
  version                       INTEGER      NOT NULL DEFAULT 1,
  idempotency_key               TEXT         UNIQUE,
  idempotency_body_hash         TEXT,

  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_client_ne_provider     CHECK (client_id <> provider_id),
  CONSTRAINT chk_held_requires_id       CHECK (escrow_status <> 'held' OR escrow_hold_id IS NOT NULL),
  CONSTRAINT chk_resolution_amount      CHECK (resolution_release_amount IS NULL
                                            OR (resolution_release_amount >= 0
                                                AND resolution_release_amount <= agreed_price)),
  CONSTRAINT chk_cancel_only_in_active  CHECK (
    (cancel_requested_by_client_at IS NULL AND cancel_requested_by_provider_at IS NULL)
    OR status = 'active' OR status = 'cancelled'
  ),
  CONSTRAINT chk_dispute_window         CHECK (dispute_resolve_by IS NULL OR dispute_opened_at IS NOT NULL)
);

CREATE INDEX idx_deals_client          ON deals (client_id, status, created_at DESC);
CREATE INDEX idx_deals_provider        ON deals (provider_id, status, created_at DESC);
CREATE INDEX idx_deals_listing         ON deals (listing_id) WHERE listing_id IS NOT NULL;

-- Timer scan indexes (partial)
CREATE INDEX idx_deals_status_timer    ON deals (status, auto_complete_after)
  WHERE status = 'in_review' AND auto_complete_after IS NOT NULL;
CREATE INDEX idx_deals_dispute_timer   ON deals (status, dispute_resolve_by)
  WHERE status = 'disputed' AND dispute_resolve_by IS NOT NULL;
CREATE INDEX idx_deals_escrow_timeout  ON deals (escrow_status, escrow_hold_requested_at)
  WHERE escrow_status = 'hold_requested';
CREATE INDEX idx_deals_release_sweep   ON deals (status, dispute_window_until)
  WHERE status = 'completed' AND escrow_release_requested_at IS NULL;
CREATE INDEX idx_deals_pending_expiry  ON deals (status, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_deals_cancel_expiry   ON deals (
    status, GREATEST(cancel_requested_by_client_at, cancel_requested_by_provider_at)
  )
  WHERE cancel_requested_by_client_at IS NOT NULL OR cancel_requested_by_provider_at IS NOT NULL;

-- v1.2: PSP hold-cap expiry sweep
CREATE INDEX idx_deals_hold_cap_expired ON deals (escrow_status, escrow_hold_cap_reached)
  WHERE escrow_status = 'hold_requested' AND escrow_hold_cap_reached = true;

CREATE TRIGGER set_deal_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- v1.3: increment provider_profiles.completed_deals_count on transition INTO 'completed'.
-- Column DDL is owned by Users & Auth spec (Module 1) provider_profiles table; the trigger
-- and the v1.3 backfill query are owned here. Synchronous because Module 13 Search reads
-- this counter at query time (30% weight in provider_quality_score) and cannot tolerate
-- eventual consistency lag the way review_count (Reviews module, separate-TX) can.
CREATE OR REPLACE FUNCTION trg_increment_completed_deals_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Increment on entry into 'completed'.
  IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    UPDATE provider_profiles
       SET completed_deals_count = completed_deals_count + 1
     WHERE user_id = NEW.provider_id;
  -- Decrement on exit FROM 'completed' (only path: completed → disputed via grace
  -- dispute, §4.5 row "completed | disputed | client | now() ≤ dispute_window_until").
  -- Floor at 0 to defend against any anomaly. Search spec REQ §30 also documents the
  -- decrement on dispute_resolved{outcome=refund_to_client} — that case is captured
  -- here transitively because the resolved-refund path is completed → disputed → cancelled,
  -- and the decrement fires on the completed → disputed leg (the cancelled leg is a no-op
  -- because OLD.status='disputed', which was never 'completed' at OLD-time).
  ELSIF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    UPDATE provider_profiles
       SET completed_deals_count = GREATEST(completed_deals_count - 1, 0)
     WHERE user_id = NEW.provider_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deal_completed_count
  AFTER UPDATE OF status ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_increment_completed_deals_count();

-- v1.3 DEPLOY MIGRATION (run once, BEFORE enabling the trigger above):
--   ALTER TABLE provider_profiles
--     ADD COLUMN IF NOT EXISTS completed_deals_count INTEGER NOT NULL DEFAULT 0;
--   UPDATE provider_profiles pp
--     SET completed_deals_count = (
--       SELECT COUNT(*) FROM deals d
--        WHERE d.provider_id = pp.user_id AND d.status = 'completed'
--     );
-- Deploy order: (1) migration runs → (2) trigger DDL applied → (3) new app code deployed.
-- Idempotency: 'completed' is terminal (CON-007); the OLD.status<>'completed' guard fires
-- exactly once per deal. Any future state machine change that adds a 'completed → ...'
-- transition MUST revisit this trigger to prevent double-counting.
```

### 4.2 Audit log — `deal_events`

```sql
CREATE TABLE deal_events (
  id           BIGSERIAL    PRIMARY KEY,
  deal_id      UUID         NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  actor_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  actor_role   TEXT         NOT NULL CHECK (actor_role IN ('client','provider','system','admin')),
  event_type   TEXT         NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_deal_events_deal  ON deal_events (deal_id, created_at DESC);
CREATE INDEX idx_deal_events_actor ON deal_events (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
```

Plain (unpartitioned) per CON-008.

### 4.3 Attachments — `deal_attachments`

```sql
CREATE TABLE deal_attachments (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      UUID         NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  uploader_id  UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_key     TEXT         NOT NULL,
  file_name    TEXT         NOT NULL,
  mime_type    TEXT         NOT NULL,
  size_bytes   BIGINT       NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600),  -- 100 MB
  visible_to   TEXT         NOT NULL DEFAULT 'both'
                 CHECK (visible_to IN ('both','client_only','provider_only')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_deal ON deal_attachments (deal_id, created_at);
```

### 4.4 Dispute escalations — `dispute_escalations`

```sql
CREATE TABLE dispute_escalations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           UUID         NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  escalated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  escalation_number INT          NOT NULL DEFAULT 1,
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID         REFERENCES users(id)
);

CREATE INDEX idx_dispute_escalations_deal       ON dispute_escalations (deal_id);
CREATE INDEX idx_dispute_escalations_unresolved ON dispute_escalations (escalated_at) WHERE resolved_at IS NULL;
```

### 4.5 State machine

```
                    (Client POST /deals + Idempotency-Key)
                                    │
                                    ▼
                           ┌────────────────┐
                           │    pending     │
                           └────────┬───────┘
       (Provider /accept ⇒ escrow_hold_requested)│ (System 72h timeout ⇒ /cancel auto)
                                    │
        (Payments callback /escrow-held ⇒ atomic)
                                    │
                                    ▼
                           ┌────────────────┐
                           │     active     │◄───────┐
                           └────────┬───────┘        │
       (Provider /submit)           │     (mutual cancel: both parties)
                                    ▼                │
                           ┌────────────────┐        │
              ┌────────────│   in_review    │────────┤
              │            └────────┬───────┘        │
   (Client /approve)        (Client /dispute)        │
   (System auto-complete after 7d)                   │
              │                     │                │
              ▼                     ▼                ▼
      ┌──────────────┐      ┌──────────────┐  ┌──────────────┐
      │  completed   │◄────►│   disputed   │  │  cancelled   │
      └──────────────┘      └──────────────┘  └──────────────┘
       (24h grace:                  │
        client may              (Admin /resolve →
        reopen dispute            completed | cancelled)
        if escrow not
        yet released)
```

State-actor-guard table:

| From | To | Actor | Guard | Side-effects |
|------|-----|------|-------|--------------|
| (none) | pending | client | Idempotency-Key + valid body | Insert deal; event `deal.created` |
| pending | active | system (Payments callback) | escrow_status='hold_requested' | Set escrow_status='held', escrow_hold_id, escrow_held_at; event `deal.activated` |
| pending | cancelled | client | status='pending' | Event `deal.cancelled_by_client` |
| pending | cancelled | provider | status='pending' | Event `deal.rejected`; outbox `deal.escrow_hold_cancelled` |
| pending | cancelled | system | created_at + 72h ≤ now() | Event `deal.expired_pending`; outbox `deal.escrow_hold_cancelled` |
| pending | cancelled | system | escrow_status='hold_requested' AND escrow_hold_requested_at + 30min ≤ now() | Event `deal.cancelled_escrow_timeout`; outbox `deal.escrow_hold_cancelled` |
| pending | cancelled | system | escrow_status='hold_requested' AND escrow_hold_cap_reached=true (v1.2; PSP signals cap via `/internal/deals/{id}/escrow-hold-cap-reached`) | Set `cancellation_reason='escrow_hold_expired'`, `escrow_status='refunded'`; event `deal.cancelled_hold_expired`; outbox `deal.cancelled_hold_expired` (notify) + `deal.escrow_hold_cancelled` (Payments) |
| active | in_review | provider | status='active' | Set review_started_at=now(), auto_complete_after=now()+7d, dispute_window_until=now()+8d; event `deal.submitted` |
| active | cancelled | client+provider | both cancel_requested_by_*_at non-null within 48h | Event `deal.cancelled_mutual`; outbox `deal.escrow_refund_requested` |
| in_review | completed | client | status='in_review' | Event `deal.approved`; outbox `deal.escrow_release_requested` (immediate) |
| in_review | completed | system | auto_complete_after ≤ now() | Event `deal.auto_completed`; **NO** immediate release event |
| completed | (release sweep) | system | dispute_window_until ≤ now() AND escrow_release_requested_at IS NULL | Set escrow_release_requested_at=now(); outbox `deal.escrow_release_requested` |
| in_review | disputed | client | status='in_review' AND now() ≤ auto_complete_after, reason ≥30 chars + ≥1 attachment | Set dispute_opened_at, dispute_resolve_by=now()+14d; event `deal.disputed` |
| completed | disputed | client | status='completed' AND now() ≤ dispute_window_until AND escrow_release_requested_at IS NULL, reason+attachment | Rollback to disputed; same event metadata |
| disputed | completed | admin | SEC-006 re-read passes | Set resolution fields; event `deal.dispute_resolved`; outbox events per outcome; close open `dispute_escalations` rows |
| disputed | cancelled | admin | SEC-006 re-read passes, outcome=refund_to_client | Set resolution fields; event `deal.dispute_resolved`; outbox `deal.escrow_refund_requested`; close escalations |
| disputed | (escalation) | system | dispute_resolve_by ≤ now() AND escalation_count=0 | Insert dispute_escalations row; extend dispute_resolve_by += 7d; increment count; event `deal.dispute_escalated` |
| disputed | cancelled | system | dispute_resolve_by ≤ now() AND escalation_count ≥ 1 | Refund-to-client (conservative default); event `deal.dispute_unresolved` |

Terminal states (`completed`, `cancelled`) accept no further state transitions.

### 4.6 REST API

All endpoints prefixed `/api/v1`. `application/json`. Auth: Bearer JWT (access token) per Auth spec, except `/internal/...` which uses service-account JWT (SEC-002).

| Method | Path | Roles | Idempotency | Purpose |
|--------|------|-------|-------------|---------|
| POST | `/deals` | client | `Idempotency-Key` required | Create pending deal |
| GET | `/deals` | client, provider | — | List own deals (filter, paginate) |
| GET | `/deals/{id}` | client, provider, admin | — | Read deal detail |
| POST | `/deals/{id}/accept` | provider | — | pending → escrow_hold_requested |
| POST | `/deals/{id}/reject` | provider | — | pending → cancelled |
| POST | `/deals/{id}/submit` | provider | — | active → in_review |
| POST | `/deals/{id}/approve` | client | — | in_review → completed |
| POST | `/deals/{id}/dispute` | client | — | in_review → disputed OR completed → disputed (grace) |
| POST | `/deals/{id}/cancel` | client, provider, admin | — | pending → cancelled (unilateral); active → cancel_requested or cancelled (mutual) |
| POST | `/deals/{id}/resolve` | admin | — | disputed → completed/cancelled with typed outcome |
| POST | `/deals/{id}/attachments` | client, provider | — | Upload attachment (rejected at terminal states) |
| GET | `/deals/{id}/attachments` | client, provider, admin | — | List attachments (filtered by visible_to) |
| GET | `/deals/{id}/events` | client, provider, admin | — | Read event log (PII-projected for non-admin) |
| POST | `/internal/deals/{id}/escrow-held` | service:payments_service | — | Payments callback: confirm escrow placement (atomic pending → active) |
| POST | `/internal/deals/{id}/escrow-hold-cap-reached` | service:payments_service | — | v1.2: Payments signals PSP hold cap reached; sets `escrow_hold_cap_reached=true` so timer worker cancels on next sweep |

#### 4.6.1 `POST /deals` — create

Request:
```http
POST /api/v1/deals
Authorization: Bearer <access_jwt>
Idempotency-Key: 7f3a9c12-4b2e-4d1a-9e8f-1234567890ab
Content-Type: application/json

{
  "provider_id":   "uuid",
  "category_id":   "uuid",
  "listing_id":    "uuid|null",
  "title":         "Ремонт пральної машини Bosch",
  "description":   "Не крутиться барабан. Потрібна діагностика та ремонт.",
  "agreed_price":  120000,
  "deadline_at":   "2026-06-01T00:00:00Z"
}
```

Responses:
- `201 Created` — new deal returned (`status`, `version`, ids, timestamps).
- `200 OK` — replay with same Idempotency-Key + matching body hash; original deal returned.
- `409 Conflict` `{"error": {"code": "idempotency_body_mismatch"}}` — same key, different body hash.
- `422 Unprocessable Entity` — validation errors (`provider_id` not a valid provider role, agreed_price ≤ 0, etc).

Body hash: SHA-256 of canonical JSON (sorted keys, no whitespace).

#### 4.6.2 Transition endpoints — generic shape

Request body for transition endpoints (`/accept`, `/submit`, `/approve`, `/cancel`, `/reject`):
```json
{ "version": 3 }
```

Response 200:
```json
{ "id": "uuid", "status": "active", "version": 4 }
```

Error responses:
- `409 Conflict` `{"error":"version_conflict","current_version":4,"current_status":"in_review"}` — version mismatch.
- `409 Conflict` `{"error":"status_conflict","current_version":3,"current_status":"completed"}` — version matches but state precondition fails.
- `403 Forbidden` `{"error":"account_suspended"}` — caller suspended; or wrong party for the action.

#### 4.6.3 `POST /deals/{id}/dispute`

```json
{
  "version": 5,
  "reason": "Робота виконана неякісно. Барабан не крутиться, провід пошкоджено.",
  "attachment_ids": ["uuid-1", "uuid-2"]
}
```
- `reason` must be ≥ 30 characters → 422 `reason_too_short` otherwise.
- `attachment_ids` must contain ≥ 1 element, each existing in `deal_attachments` with `deal_id=$id` and `uploader_id=caller` → 422 `attachment_required` / `attachment_not_found`.
- 409 `escrow_already_released` if `status='completed'` AND `escrow_release_requested_at IS NOT NULL`.

#### 4.6.4 `POST /deals/{id}/resolve` (admin)

```json
{
  "version": 7,
  "outcome": "split",
  "release_amount_kopecks": 85000,
  "resolution_note": "Часткове виконання роботи. Згідно з наданими доказами провайдер заслуговує 70% узгодженої суми."
}
```
- `outcome ∈ {release_to_provider, refund_to_client, split}` → 422 `invalid_outcome` otherwise.
- `release_amount_kopecks` for `split`: `0 < amount < agreed_price`. For `release_to_provider`: defaults to `agreed_price`. For `refund_to_client`: defaults to `0`.
- `resolution_note` non-empty (min 10 chars).
- Handler executes atomically in a single transaction: (1) UPDATE deals (resolution fields + status); (2) UPDATE `dispute_escalations SET resolved_at=now(), resolved_by=$admin_id WHERE deal_id=$id AND resolved_at IS NULL`.
- SEC-006 re-read of admin role from primary DB precedes the transaction.

#### 4.6.5 `POST /internal/deals/{id}/escrow-held`

Auth: service-account JWT (SEC-002). Request:
```json
{ "version": 1, "escrow_hold_id": "uuid" }
```
Atomic UPDATE:
```sql
UPDATE deals
SET escrow_status='held', escrow_hold_id=$1, escrow_held_at=now(),
    status='active', version=version+1, updated_at=now()
WHERE id=$2 AND escrow_status='hold_requested' AND status='pending' AND version=$3;
```
0 rows → 409 `version_conflict` or `status_conflict` per re-read.

#### 4.6.6 `POST /internal/deals/{id}/escrow-hold-cap-reached` (v1.2)

Auth: service-account JWT (SEC-002 pattern, identical to `/escrow-held`). Request:
```json
{ "version": 1, "hold_expired_at": "2026-05-09T10:00:00Z", "original_hold_amount_minor": 120000 }
```
Atomic UPDATE:
```sql
UPDATE deals
SET escrow_hold_cap_reached=true, version=version+1, updated_at=now()
WHERE id=$1 AND escrow_status='hold_requested' AND escrow_hold_cap_reached=false AND version=$2;
```
0 rows → 409 `version_conflict` or `status_conflict` per re-read. The actual cancellation transition (`pending → cancelled` with `cancellation_reason='escrow_hold_expired'`) is performed asynchronously by the timer worker on its next sweep, NOT inside this callback — this keeps the callback fast and idempotent and concentrates outbox emission in the worker (PAT-002).

### 4.7 PII projection on `GET /deals/{id}/events`

For non-admin callers: `ip` and `user_agent` are stripped from every row. `metadata` is filtered per event_type:

| event_type | Party-visible metadata keys | Admin-only keys |
|---|---|---|
| `deal.created` | title, agreed_price, category_id | ip, user_agent |
| `deal.accepted` | (none) | ip, user_agent |
| `deal.activated` | (none) | escrow_hold_id, ip, user_agent |
| `deal.rejected` | rejection_reason | ip, user_agent |
| `deal.submitted` | (none) | ip, user_agent |
| `deal.approved` | (none) | ip, user_agent |
| `deal.disputed` | reason, attachment_ids | ip, user_agent |
| `deal.auto_completed` | (none) | (none — system event) |
| `deal.cancel_requested` | requested_by_role | ip, user_agent |
| `deal.cancelled_mutual` | (none) | (none — system event) |
| `deal.cancelled_escrow_timeout` | (none) | (none — system event) |
| `deal.expired_pending` | (none) | (none — system event) |
| `deal.dispute_resolved` | outcome, release_amount_kopecks | resolution_note, admin_id, ip, user_agent |
| `deal.dispute_escalated` | escalation_number | (none — system event) |
| `deal.dispute_unresolved` | (none) | (none — system event) |
| `deal.transition_rejected` | attempted_from, attempted_to, conflict_type | submitted_version, ip, user_agent |
| `deal.attachment_added` | attachment_id, file_name, visible_to | ip, user_agent |
| `deal.escrow_hold_confirmed` | (not surfaced to parties) | escrow_hold_id |
| `deal.escrow_hold_stalled` | (not surfaced to parties) | (none) |
| `deal.cancelled_hold_expired` | cancelled_at, hold_expired_at, original_hold_amount_minor, currency | (none — system event) |
| `deal.escrow_hold_warning` | hold_expires_at, hours_remaining | (none — system event) |

Implementation: app-layer `project_event_metadata(event_type, metadata, caller_role)` function. Whitelist as compile-time constant map. Both parties see the same projection on shared events.

### 4.8 Outbox event registry

#### 4.8.1 Payments-consumed events (v1.0)

| Event type | Emitted on | Payload keys |
|---|---|---|
| `deal.created` | POST /deals success | deal_id, client_id, provider_id, agreed_price, category_id |
| `deal.escrow_hold_requested` | Provider /accept | deal_id, agreed_price, client_id, provider_id |
| `deal.escrow_hold_cancelled` | pending → cancelled (any path with prior hold_requested) | deal_id, escrow_hold_id |
| `deal.activated` | escrow callback transitions to active | deal_id, escrow_hold_id |
| `deal.escrow_release_requested` | client /approve OR release sweep (after dispute_window_until) | deal_id, amount_kopecks, escrow_hold_id |
| `deal.escrow_refund_requested` | mutual cancel from active OR admin /resolve refund/split | deal_id, amount_kopecks, escrow_hold_id |
| `deal.escrow_partial_release` | admin /resolve outcome=split | deal_id, release_amount_kopecks, refund_amount_kopecks, escrow_hold_id |

Consumed by Payments module. Producer (Deal service) is NOT a system of record for escrow funds.

#### 4.8.2 Notification-consumed events (v1.1)

Added in v1.1 as a hard prerequisite for Notifications Module 9 and Messaging Module 10. These events are emitted to `outbox_events` in the SAME transaction as the corresponding state mutation (or the timer-worker UPDATE), with `aggregate_type='deal'`. They MUST be present so that the Notifications worker (`aggregate_type IN ('deal','review','user','message','conversation')`) can route user-facing notifications without polling `deal_events`.

| Event type | Emitted on | Payload keys |
|---|---|---|
| `deal.rejected` | Provider `POST /deals/{id}/reject` (pending → cancelled by provider rejection) | deal_id, client_id, provider_id, rejection_reason |
| `deal.cancel_requested` | Either party first `POST /deals/{id}/cancel` from active (cancel-consent flow) | deal_id, client_id, provider_id, requested_by_role, requested_by_user_id |
| `deal.cancelled_by_client` | Client `POST /deals/{id}/cancel` from pending | deal_id, client_id, provider_id |
| `deal.cancelled_mutual` | Second party completes mutual cancel (active → cancelled, both parties consented) | deal_id, client_id, provider_id |
| `deal.expired_pending` | Timer worker 72h pending-expiry sweep | deal_id, client_id, provider_id |
| `deal.submitted` | Provider `POST /deals/{id}/submit` (active → in_review) | deal_id, client_id, provider_id |
| `deal.approved` | Client `POST /deals/{id}/approve` (in_review → completed) | deal_id, client_id, provider_id |
| `deal.disputed` | Client `POST /deals/{id}/dispute` | deal_id, client_id, provider_id |
| `deal.dispute_resolved` | Admin `POST /deals/{id}/resolve` | deal_id, client_id, provider_id, outcome |
| `deal.dispute_escalated` | Dispute SLA timer sweep (14d → escalate) | deal_id, escalation_number |
| `deal.dispute_unresolved` | Dispute SLA second-expiry sweep (refund-to-client cancel path) | deal_id, client_id, provider_id |
| `deal.auto_completed` | Timer worker auto-complete sweep (in_review → completed after 7d grace) | deal_id, client_id, provider_id |
| `deal.cancelled_hold_expired` (v1.2) | Timer worker `escrow_hold_timeout` sweep when `escrow_hold_cap_reached=true` (PSP hold cap expired before deal accepted) | deal_id, client_id, provider_id, listing_id, cancelled_at, hold_expired_at, original_hold_amount_minor, currency |
| `deal.escrow_hold_warning` (v1.2) | T-24h before PSP hold cap expiry — **emitted by Payments module (Module 11)**, NOT the Deal service. Declared here for cross-spec discoverability of the `deal.*` namespace. | deal_id, client_id, provider_id, hold_expires_at, hours_remaining (SMALLINT) |

**Consumed by:** Notifications module (Module 9) for user-facing notifications; Messaging module (Module 10) for the deal-conversation lock-by-deal handler that fires on `deal.approved`, `deal.auto_completed`, `deal.cancelled_*`, `deal.dispute_resolved`, `deal.dispute_unresolved`.

**Idempotency for `deal.cancelled_hold_expired`:** key = `'deal.cancelled_hold_expired:' || deal_id`; the outbox UNIQUE constraint on `(aggregate_type, aggregate_id, event_type, idempotency_key)` prevents double-emission across worker retries. Producer is the Deal-service timer worker (§4.9). Consumer is Notifications.

**Cross-spec emission for `deal.escrow_hold_warning`:** producer is Payments (Module 11), which owns the T-24h timer logic, idempotency key, and emission code path. The Deal spec declares this event purely for `aggregate_type='deal'` namespace cohesion so Notifications routing remains consistent.

**Emission constraint:** All events in §4.8.2 are emitted via `INSERT INTO outbox_events` inside the same transaction as the corresponding `deals` UPDATE (for synchronous transitions) or the timer-worker `UPDATE ... RETURNING` row (for sweeps). On 0 rows returned by the guarded UPDATE, no outbox event is emitted (PAT-002 idempotency).

**Polling fallback explicitly forbidden:** Consumers MUST NOT scan `deal_events` directly for notification routing. The outbox is the canonical integration channel.

### 4.9 Timer worker contracts

The worker runs every 60 seconds (escrow timeout sweep every 5 minutes). Each sweep:

```sql
-- Auto-complete from in_review
SELECT id FROM deals
  WHERE status='in_review' AND auto_complete_after <= now()
  FOR UPDATE SKIP LOCKED LIMIT 200;
-- For each id:
UPDATE deals SET status='completed', version=version+1, updated_at=now()
WHERE id=$1 AND status='in_review' AND auto_complete_after <= now()
RETURNING id, version;
-- 0 rows = silent no-op. Outbox event emitted only on RETURNING row.

-- Release sweep (decoupled from auto-complete to avoid double-release race)
SELECT id FROM deals
  WHERE status='completed' AND escrow_release_requested_at IS NULL AND dispute_window_until <= now()
  FOR UPDATE SKIP LOCKED LIMIT 200;
-- For each:
UPDATE deals SET escrow_release_requested_at=now()
WHERE id=$1 AND escrow_release_requested_at IS NULL;
-- emit deal.escrow_release_requested

-- Pending expiry (72h)
-- Cancel consent expiry (48h)
-- Escrow hold timeout (15min alert / 30min auto-cancel / PSP hold-cap expiry cancel — v1.2)
--   PSP hold-cap path: Payments calls /internal/.../escrow-hold-cap-reached → flag set;
--   timer sweep matches escrow_status='hold_requested' AND escrow_hold_cap_reached=true →
--     UPDATE deals SET status='cancelled', cancellation_reason='escrow_hold_expired',
--                      escrow_status='refunded', version=version+1, updated_at=now()
--      WHERE id=$1 AND escrow_status='hold_requested' AND escrow_hold_cap_reached=true
--      RETURNING id;
--   On RETURNING row, emits deal.cancelled_hold_expired + deal.escrow_hold_cancelled.
-- Dispute SLA (14d → escalate; on second expiry → refund-to-client cancel)
```

All sweep UPDATEs include the timer condition in the WHERE clause for idempotency (PAT-002). N=200 cap per sweep; on saturation the worker re-runs immediately.

Metrics (Prometheus):
- `timer_worker_sweep_duration_seconds{sweep_type}` (histogram)
- `timer_worker_transitions_total{sweep_type, outcome}` (counter)
- `timer_worker_backlog_deals_total{sweep_type}` (gauge)
- `timer_worker_sweep_capped_total{sweep_type}` (counter)
- `escrow_release_sweep_total{outcome}` (counter)
- `transition_audit_write_failures_total{event_type, deal_id_prefix}` (counter)

Alerts:
- `timer_worker_backlog_deals_total > 500` for any `sweep_type` for 5 min → PagerDuty P2.
- `rate(transition_audit_write_failures_total[5m]) > 0.1` → non-paging alert.

## 5. Acceptance Criteria

- **AC-001**: Given a Client with a valid JWT, When the Client POSTs to `/deals` with a unique Idempotency-Key and valid body, Then a row is inserted with `status='pending'`, `escrow_status='not_required'`, `version=1`, the body hash is stored, and `deal.created` is appended to `deal_events` and to `outbox_events` in the same transaction.
- **AC-002**: Given a duplicate POST with the same Idempotency-Key and matching body hash, Then the original deal is returned with HTTP 200 (no new row).
- **AC-003**: Given a duplicate POST with the same Idempotency-Key and a different body hash, Then HTTP 409 `idempotency_body_mismatch` is returned and no new row is inserted.
- **AC-004**: Given a pending deal, When the Provider POSTs to `/accept` with the correct version, Then `escrow_status` becomes `hold_requested`, `escrow_hold_requested_at` is set, `deal.escrow_hold_requested` is enqueued, AND `status` REMAINS `pending`.
- **AC-005**: Given an authenticated service account with `payments_service` role re-read OK from DB, When the service POSTs to `/internal/deals/{id}/escrow-held` for a deal with `escrow_status='hold_requested'`, Then in a single transaction the deal transitions `pending → active`, `escrow_status → held`, `escrow_hold_id` is populated, and `deal.activated` is emitted.
- **AC-006**: Given a deal in `in_review` with `auto_complete_after <= now()`, When the timer sweep runs, Then `status` transitions to `completed`, version increments, and `deal.escrow_release_requested` is NOT emitted in the same transaction.
- **AC-007**: Given a completed deal with `dispute_window_until <= now()` and `escrow_release_requested_at IS NULL`, When the release sweep runs, Then `escrow_release_requested_at = now()` is set and `deal.escrow_release_requested` is emitted exactly once.
- **AC-008**: Given a completed deal with `now() <= dispute_window_until` AND `escrow_release_requested_at IS NULL`, When the Client POSTs to `/dispute` with valid reason+attachments, Then status rolls back to `disputed`, `dispute_opened_at=now()`, `dispute_resolve_by=now()+14d`.
- **AC-009**: Given a completed deal with `escrow_release_requested_at IS NOT NULL`, When the Client POSTs to `/dispute`, Then HTTP 409 `escrow_already_released` is returned and the deal status does NOT change.
- **AC-010**: Given an active deal where one party has POSTed `/cancel` and the other party has not within 48 hours, When the cancel-expiry sweep runs, Then `cancel_requested_by_*_at` is reset to NULL, version increments, and `deal.cancel_request_expired` is emitted.
- **AC-011**: Given an active deal where both parties POST `/cancel` within 48 hours, When the second `/cancel` arrives, Then a single atomic UPDATE sets the second column AND transitions status to `cancelled` AND emits `deal.cancelled_mutual` AND outbox `deal.escrow_refund_requested`, all in one transaction.
- **AC-012**: Given two concurrent `/approve` and `/dispute` calls from the Client on the same in_review deal at version V, When both UPDATE statements race, Then exactly one succeeds (status determined by which arrived first); the loser receives 409 `version_conflict` or `status_conflict` with `current_version` and `current_status`; a `deal.transition_rejected` row is appended to `deal_events` best-effort.
- **AC-013**: Given an Admin POSTs to `/resolve` with valid typed payload, When the SEC-006 admin re-read succeeds, Then in a single transaction the deal transitions out of `disputed` with the resolution fields populated AND any open rows in `dispute_escalations WHERE deal_id=$id AND resolved_at IS NULL` are marked resolved with `resolved_at=now()`, `resolved_by=admin_id`.
- **AC-014**: Given an Admin POSTs to `/resolve` with `outcome='split'`, `release_amount_kopecks=70000`, `agreed_price=100000`, Then `deal.escrow_release_requested` (amount=70000) AND `deal.escrow_refund_requested` (amount=30000) are both emitted to outbox.
- **AC-015**: Given a non-admin caller GETs `/deals/{id}/events`, Then the response strips `ip`, `user_agent`, and any `metadata` keys not on the per-event-type whitelist.
- **AC-016**: Given an admin caller GETs `/deals/{id}/events`, Then the response includes `ip`, `user_agent`, and full `metadata` JSONB unmodified.
- **AC-017**: Given a Provider whose `users.status='suspended'`, When the Provider POSTs to `/accept` or `/submit`, Then HTTP 403 `account_suspended` is returned. Existing deals where the suspended Provider is `provider_id` are NOT auto-cancelled; admin must `/cancel` with admin role and `cancellation_reason='provider_suspended'`.
- **AC-018**: Given a user with status `active` and at least one open deal (`status IN (pending, active, in_review, disputed)`), When the user calls `DELETE /users/me`, Then HTTP 409 `open_deals_exist` is returned with the list of `deal_ids`.
- **AC-019**: Given a deal with `status IN (completed, cancelled)` OR `resolved_at IS NOT NULL`, When any party POSTs to `/attachments`, Then HTTP 409 `deal_terminal_state` is returned and no row is inserted in `deal_attachments`.
- **AC-020**: Given a deal with `escrow_status='hold_requested'` and `escrow_hold_requested_at + 30min <= now()`, When the escrow-timeout sweep runs, Then status transitions to `cancelled`, `cancellation_reason='escrow_timeout'`, and `deal.cancelled_escrow_timeout` is emitted.
- **AC-021**: Given a disputed deal with `dispute_resolve_by <= now()` and `dispute_escalation_count=0`, When the dispute-expiry sweep runs, Then a `dispute_escalations` row is inserted, `dispute_resolve_by` is extended by 7 days, `dispute_escalation_count=1`, and `deal.dispute_escalated` is emitted.
- **AC-022**: Given a disputed deal with `dispute_resolve_by <= now()` and `dispute_escalation_count>=1`, When the sweep runs, Then status transitions to `cancelled` with `cancellation_reason='dispute_unresolved'` and `deal.escrow_refund_requested` (amount=agreed_price) is emitted.
- **AC-023**: SLA timestamps (`auto_complete_after`, `dispute_window_until`, `dispute_resolve_by`) computed inside the transition UPDATE statements using `now() + interval '...'`. The application layer SHALL NOT pass timestamps for these fields.

## 6. Test Automation Strategy

- **Test Levels**: Unit (state-machine guards, projection function), Integration (REST endpoints + DB), End-to-End (full flow with Payments stub).
- **Frameworks**: language-agnostic at spec level. Test harness must support: PostgreSQL 15 testcontainer, JWT minting (RS256), Prometheus metric scrape assertions, HTTP request/response assertions.
- **Test Data Management**: per-test schema migrations applied to a fresh DB per integration test class. Seed minimal `users`, `categories`, and (where relevant) `listings` rows.
- **CI/CD Integration**: full integration suite runs on every PR. Contract tests against the Payments stub (canned `/internal/deals/{id}/escrow-held` callback).
- **Coverage Requirements**: ≥ 90 % line coverage on the deal service module; 100 % branch coverage on the state-transition switch statement.
- **Performance Testing**: loadgen scenario — 100 concurrent `POST /deals` with unique Idempotency-Keys, then 100 concurrent `/accept` calls; assert no `version_conflict` storms, p99 latency < 200 ms.
- **Race tests**: deterministic concurrency tests for AC-011 (mutual cancel), AC-012 (approve+dispute), AC-006 (timer race with API call). Use DB advisory locks or `pg_sleep` injections to control timing.

## 7. Rationale & Context

### State-machine actor decisions

- **Provider triggers `in_review`, not Client.** Provider signals delivery; Client signals acceptance. Matches Upwork/Fiverr conventions and prevents Clients from force-completing deals to deny review rights.
- **Admin-only dispute resolution.** Disputed deals involve money and reputation; neither party is neutral. A `moderator` role could be granted resolution rights in v1.1 without schema changes.
- **System auto-complete after 7 days in_review.** Prevents Clients from indefinitely holding Provider payment by ignoring review. Aligns with Upwork's default 7-day review window.
- **Mutual cancel from active.** Active deals may be mid-execution; unilateral cancellation creates fraud incentives in both directions. Mutual consent forces negotiation and audit-trails the consent.

### Escrow callback design (RISK-03 resolution)

Provider `/accept` does NOT directly transition to `active`. The deal stays `pending` until the Payments module confirms escrow placement via the internal callback. This eliminates the failure mode where the Payments outbox event is lost and the deal exists in `active` without funds held. A 30-minute compensating timer auto-cancels stuck holds, so a missed callback never strands a deal indefinitely.

### Deferred release sweep (RISK-C resolution)

Auto-complete from `in_review` only sets `status='completed'`; it does NOT emit `deal.escrow_release_requested`. A separate 60-second sweep emits the release event after `dispute_window_until <= now()` (24h after auto-complete). The 24h gap eliminates the double-release race where a Client opens a dispute in the grace window after Payments has already released funds. The cost — up to 24h delay between deal completion and Provider payout — is acceptable given the platform's stated escrow-held-period model.

### Idempotency without Redis (RISK-10 resolution)

The Round-1 design used Redis (TTL 24h) + DB UNIQUE (permanent). After 24h the Redis key expired but the DB UNIQUE remained, producing surprise 409s for legitimate retries. The final design uses DB-only: `idempotency_key UNIQUE` + `idempotency_body_hash`. On UNIQUE conflict, the handler does a SELECT and compares body hashes — match returns the original deal (200), mismatch returns 409. Permanent retention is consistent with Stripe-style idempotency. Index growth (~80 MB/year at 1M deals/year) is negligible at MVP scale.

### `deal_events` unpartitioned (RISK-9, RISK-15 resolution)

Partitioning by time-range was dropped because the primary access pattern (`WHERE deal_id=$id ORDER BY created_at DESC`) does not benefit from time-range partitioning. PG15 does NOT auto-create partitions, so a missed maintenance run causes all transitions in a new month to fail at the DB layer — a real production-outage class introduced by an unjustified optimization. Partitioning is deferred until row count exceeds ~10M or a time-range compliance access pattern emerges.

### PII projection on `/events` (SEC-003, SEC-004)

`ip` and `user_agent` are PII under Ukrainian personal data law. Surfacing the counterparty's IP and UA in a dispute creates legal liability and a deanonymization vector. The per-event-type metadata whitelist additionally prevents internal system fields from leaking.

### Internal callback authentication (SEC-002)

Network isolation alone is insufficient — a compromised internal service or SSRF can manufacture confirmed-escrow deals. The callback uses an RS256 service-account JWT with the dedicated `payments_service` role, validated via SEC-006-style DB re-read. The Payments module mints these JWTs with 5-minute TTL using the existing INF-003 RS256 key infrastructure. mTLS would also work but requires per-service certificate rotation infrastructure not yet present.

### SLA defaults — legal caveat (GUD-004)

The 7-day auto-complete window, 24h post-auto-complete grace period, 14-day dispute resolution SLA, and 48h cancel consent window are presented as architectural defaults. These are de-facto product and legal decisions. Under ЗУ "Про захист прав споживачів" (Ukrainian consumer protection law), automatic state transitions that extinguish a consumer's right to contest a transaction may need to be disclosed in ToS and may face regulatory challenge. **All SLA defaults SHALL be reviewed by qualified Ukrainian consumer-protection legal counsel before production launch.** The 24h grace period is a conservative minimum addressing the gap where a Client cannot reasonably respond within the auto-complete window.

### Residual risks (formally accepted)

- **Index growth on `idempotency_key`**: documented; mitigation path = future partial index. Not actioned in v1.
- **24h release delay**: accepted tradeoff for race elimination.
- **mTLS deferred** for internal callback: defence-in-depth via service-account JWT + network isolation. mTLS migration path is documented.
- **`deal.transition_rejected` outbox routing deferred**: v1 uses Prometheus counter on separate-tx failure. Outbox routing in v1.1.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001**: Payments module — consumer of `deal.escrow_*` outbox events; producer of `POST /internal/deals/{id}/escrow-held` callbacks. Stubbed at MVP per umbrella CON-002.
- **EXT-002**: Notifications module — consumer of all `deal.*` outbox events for user-facing notifications.
- **EXT-003**: Reviews module — consumer of `deal.approved` and `deal.auto_completed` events; unlocks review eligibility.
- **EXT-004**: Object storage (S3-compatible) — stores attachment binaries referenced by `deal_attachments.file_key`. Owned by Media Pipeline module.

### Third-Party Services
- **SVC-001**: PagerDuty — receives P2 alerts on timer worker backlog. SLA: alert delivery < 1 min.

### Infrastructure Dependencies
- **INF-001**: PostgreSQL 15+ primary cluster — strong consistency for state transitions; supports `FOR UPDATE SKIP LOCKED`, partial indexes, JSONB.
- **INF-002**: `outbox_events` table (defined in Category Tree spec) — at-least-once delivery of domain events.
- **INF-003**: RS256 key-management infrastructure (defined in Auth spec) — reused for service-account JWTs.
- **INF-004**: Prometheus + Alertmanager — metric collection and alert routing.

### Data Dependencies
- **DAT-001**: `users` table (Auth spec) — FK source for `client_id`, `provider_id`, uploader_id, resolved_by_admin_id.
- **DAT-002**: `user_roles` table (Auth spec) — SEC-006 admin re-read source; service-account `payments_service` role lives here.
- **DAT-003**: `categories` table (Category Tree spec) — FK source for `category_id`.
- **DAT-004**: `listings` table (future Listings spec) — optional FK source for `listing_id`.

### Technology Platform Dependencies
- **PLT-001**: PostgreSQL 15+ — required for `gen_random_uuid()` (without pgcrypto extension), partial indexes with expressions, generated columns syntax compatibility.

### Compliance Dependencies
- **COM-001**: ЗУ "Про захист прав споживачів" (Ukrainian Consumer Protection Law) — SLA defaults subject to legal review (GUD-004).
- **COM-002**: ЗУ "Про захист персональних даних" (Ukrainian Personal Data Protection Law) — PII projection on `GET /events` (SEC-003, SEC-004); IP/UA stored only in `deal_events` admin-visible fields.

## 9. Examples & Edge Cases

### 9.1 Successful happy-path (single deal, no dispute)

```
T0   Client POST /deals  ──────────────────────► status=pending,        escrow_status=not_required
T1   Provider /accept    ──────────────────────► status=pending,        escrow_status=hold_requested
                                                  outbox: deal.escrow_hold_requested
T2   Payments POST /internal/.../escrow-held ──► status=active,         escrow_status=held
                                                  outbox: deal.activated
T3   Provider /submit    ──────────────────────► status=in_review,      auto_complete_after=T3+7d, dispute_window_until=T3+8d
T4   Client /approve     ──────────────────────► status=completed
                                                  outbox: deal.escrow_release_requested  (immediate, Client-driven)
```

### 9.2 Auto-complete with grace window (no dispute)

```
T0..T3  same as 9.1
T4 = T3 + 7d    timer worker sweeps  ─────────► status=completed
                                                NO escrow_release_requested emitted
T5 = T4 + 24h   release-sweep         ─────────► escrow_release_requested_at=T5
                                                outbox: deal.escrow_release_requested
```

### 9.3 Auto-complete with grace dispute (race resolved by sweep ordering)

```
T0..T4   as 9.2, status=completed at T4
T4.5     Client /dispute (within grace window)
         WHERE status='completed' AND now()<=dispute_window_until AND escrow_release_requested_at IS NULL
         ────────────────────────────────────► status=disputed, dispute_resolve_by=T4.5+14d
         release-sweep at T5 finds NO matching row (status no longer 'completed')
         → no double release
```

### 9.4 Escrow callback never arrives

```
T0   Client POST /deals  ──► status=pending
T1   Provider /accept    ──► escrow_status=hold_requested, escrow_hold_requested_at=T1
                              outbox: deal.escrow_hold_requested  (assume LOST in transit)
T1+15min  alert sweep  ────► outbox: deal.escrow_hold_stalled
T1+30min  cancel sweep  ───► status=cancelled, cancellation_reason='escrow_timeout'
                              outbox: deal.cancelled_escrow_timeout
```

### 9.5 Concurrent approve + dispute by same client

```
Both requests read version=5, status=in_review.
Request A (approve):  UPDATE ... SET status='completed', version=6 WHERE id=X AND version=5 AND status='in_review';
                      → 1 row affected → returns 200, status=completed, version=6
Request B (dispute):  UPDATE ... SET status='disputed', version=6 WHERE id=X AND version=5 AND status='in_review';
                      → 0 rows affected → re-read finds version=6 status=completed
                      → 409 status_conflict (version matched but status differs)
                      → deal_events row inserted (separate transaction, best-effort):
                         event_type='deal.transition_rejected'
                         metadata={attempted_from:'in_review', attempted_to:'disputed', conflict_type:'status_conflict', submitted_version:5, current_version:6}
```

### 9.6 Mutual cancel

```
T0   status=active, version=10, both cancel_requested_*_at IS NULL
T1   Client POSTs /cancel with version=10
     UPDATE deals SET cancel_requested_by_client_at=now(),
                      status=CASE WHEN cancel_requested_by_provider_at IS NOT NULL THEN 'cancelled' ELSE status END,
                      version=11
     WHERE id=X AND status='active' AND version=10
     RETURNING ...;
     → status='active' (provider hasn't cancelled), event 'deal.cancel_requested'
T2   Provider POSTs /cancel with version=11
     UPDATE deals SET cancel_requested_by_provider_at=now(),
                      status=CASE WHEN cancel_requested_by_client_at IS NOT NULL THEN 'cancelled' ELSE status END,
                      version=12
     WHERE id=X AND status='active' AND version=11
     RETURNING ...;
     → status='cancelled', event 'deal.cancelled_mutual', outbox 'deal.escrow_refund_requested'
```

### 9.7 Provider account suspended mid-deal

```
status=in_review, provider users.status='active'
admin suspends provider → users.status='suspended'

Provider attempts /submit on a different deal (status=active):
  endpoint guard: SELECT users.status WHERE id=$provider_id;
  status='suspended' → return 403 account_suspended

Existing in_review deal: NOT auto-cancelled.
Client may still /approve or /dispute normally.
Auto-complete timer continues to function.

Admin path: POST /deals/{id}/cancel with admin JWT and cancellation_reason='provider_suspended'.
```

### 9.8 Idempotency replay edge cases

```
Day 0  POST /deals  Idempotency-Key=K, body=B1  → 201, deal D1
Day 0  POST /deals  Idempotency-Key=K, body=B1  → 200, deal D1 (replay, body match)
Day 0  POST /deals  Idempotency-Key=K, body=B2  → 409 idempotency_body_mismatch
Day 100  POST /deals  Idempotency-Key=K, body=B1  → 200, deal D1 (still works, no TTL)
Day 100  POST /deals  Idempotency-Key=K, body=B2  → 409 idempotency_body_mismatch (still rejected)
Day 100  POST /deals  Idempotency-Key=K2, body=B1  → 201, new deal D2 (different key)
```

## 10. Validation Criteria

A conforming implementation MUST satisfy:

1. All AC-001 through AC-023.
2. DDL matches §4.1–§4.4 byte-for-byte after normalization (formatting differences allowed; constraint names, column types, and CHECK predicates exact).
3. The state-machine table in §4.5 is the authoritative legal-transition list; any transition not in the table MUST return 422 `invalid_transition`.
4. The PII projection whitelist in §4.7 is exact; non-admin responses MUST NOT contain keys outside the listed party-visible set.
5. The outbox event registry in §4.8 is the complete event taxonomy; consumers can rely on no event types being added without a spec revision.
6. Timer worker SHALL implement all six sweep types in §4.9.
7. Service-account JWT authentication for `/internal/...` endpoints MUST include DB role re-read; JWT-claim-only acceptance is non-conformant.
8. SLA timestamps (`auto_complete_after`, `dispute_window_until`, `dispute_resolve_by`) MUST be computed via `now() + interval '...'` inside the DB UPDATE; application-layer-computed values are non-conformant.

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-marketplace-social-platform.md`](./spec-architecture-marketplace-social-platform.md) — umbrella spec; CON-002 (no payment processing at MVP), BIZ-001 (this module).
- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — Module 1; SEC-006 admin role re-read pattern; INF-003 RS256 key infra reused for service-account JWTs; soft-delete blocking interaction (AC-009 there ↔ AC-018 here).
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — Module 2; `categories.id` is the FK target for `deals.category_id`; `outbox_events` table DDL.
- [`spec/spec-architecture-payments.md`](./spec-architecture-payments.md) — Module 11; consumer of `deal.escrow_*` events; producer of `/internal/deals/{id}/escrow-held` and (v1.2) `/internal/deals/{id}/escrow-hold-cap-reached` callbacks; producer of `deal.escrow_hold_warning` (T-24h PSP cap warning).
- Future: `spec/spec-architecture-listings.md` — owner of `listings.id`, source of optional `deals.listing_id`.
- [`spec/spec-architecture-reviews.md`](./spec-architecture-reviews.md) — consumer of `deal.approved` / `deal.auto_completed` events for review eligibility.
- [`spec/spec-architecture-search-discovery.md`](./spec-architecture-search-discovery.md) — Module 13; reads `provider_profiles.completed_deals_count` (30% weight in provider quality score). Column is incremented by `trg_deal_completed_count` defined in §4.1; v1.3 backfill query is documented inline there. Column DDL itself is owned by Users & Auth spec (Module 1).
- Закон України "Про захист прав споживачів" — SLA defaults legal review (GUD-004).
- Закон України "Про захист персональних даних" — IP/UA exposure on `/events` (SEC-003).
