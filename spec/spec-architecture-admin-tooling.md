---
title: Admin Tooling — Unified Backoffice, Audit Reader, RBAC, MFA Re-auth
version: 1.0
date_created: 2026-05-08
last_updated: 2026-05-08
owner: Platform / Trust & Safety
tags: [architecture, admin, moderation, rbac, audit, mfa, backoffice]
---

# Introduction

Module 12 — Admin Tooling is the unified backoffice for admin and moderator operators. It aggregates every pending admin queue from prior modules (KYC, Listings, Reviews, Messaging, Media, Payments, Deal disputes, Category proposals) into a single inbox, exposes a cross-domain audit timeline reader, codifies a three-tier RBAC matrix, enforces MFA re-authentication for high-impact actions, applies session policy stricter than the user-side default (4h max / 30min idle), and writes an immutable `admin_actions` audit log. It does NOT define new domain mutation endpoints — those live in their owning modules; this module references them.

## 1. Purpose & Scope

This specification defines:

- The unified admin queue: read-time UNION across 10 source tables, normalized to `(item_id, source_table, item_type, severity, age_minutes, status, payload, created_at)`. Severity is a FILTER parameter; pagination is keyset-based on `(created_at, id)` only.
- Cross-domain audit timeline: UNION across `audit_events`, `deal_events`, `kyc_review_events`, `ledger_entries` (joined to `ledger_accounts.owner_id`), and `admin_actions` (joined on the new denormalized `user_id` column).
- Full-text search over `audit_events` via a separate `admin_audit_search_index` projection table populated by a dedicated outbox-driven consumer (avoids retroactive ALTER on partitioned `audit_events`).
- RBAC matrix in `admin_permissions` seed table: `admin` (full), `moderator` (content only — no KYC/finance/dispute), `support` (read-only audit + user search + queue view).
- Admin sessions table separate from `auth_sessions` with stricter policy (4h max, 30min idle), FK ON DELETE CASCADE for cleanup safety; split read/write paths to avoid request serialization.
- MFA challenge model: short-lived single-use tokens in `admin_mfa_challenges`, 5-minute TTL, KMS-degraded fallback returns 503 with Retry-After.
- Immutable `admin_actions` log with denormalized `user_id` for per-user timeline filtering, application-role REVOKE on UPDATE/DELETE (mirrors KYC SEC-006), column-level projection for `support` role.
- Bulk operations: max 10 targets per op (DB CHECK), 4-eyes for irreversible (DB CHECK `approved_by <> initiated_by`).
- User search and denormalized detail snapshot wrapped in `REPEATABLE READ` transaction.
- No outbox events emitted by Admin Tooling — `admin_actions` is the audit record; user-facing notifications are emitted by the producing modules (Auth `user.suspended`, KYC `kyc.rejected`, etc.).

**Audience:** backend, T&S operators, security reviewers.

**Assumptions:** PostgreSQL 15+, Redis 7+, REST/JSON over HTTPS, JWT (RS256, 15-min access). All timestamps `TIMESTAMPTZ` UTC.

**Out of scope:** OAuth/SAML for admin login, IP allow-listing implementation (config-driven ops decision), broadcast notifications, analytics dashboard, sanctions screening, GraphQL, WebSocket queue push, multi-locale admin UI, S3 inspection UI, per-role rate limits, two-person integrity for KYC approval (schema-compatible, deferred), full-locale FTS for Ukrainian morphology (uses `simple` tokenizer at MVP).

## 2. Definitions

- **Admin** — user with `user_roles.role='admin'`; full permission set.
- **Moderator** — user with `user_roles.role='moderator'`; content-only operations (listings, reviews, messages, media). NO financial, KYC, dispute resolution, user suspension.
- **Support** — user with `user_roles.role='support'`; read-only audit + user search + queue view.
- **MFA challenge** — short-lived single-use token issued after fresh TOTP verification; required header on high-impact mutations.
- **High-impact action** — action requiring fresh MFA challenge: account suspension, role grant/revoke, KYC reject post-appeal, payout approval, chargeback resolution, deal dispute resolution, bulk operations.
- **4-eyes** — irreversible bulk operations require approval by a second admin distinct from the initiator.
- **`admin_actions`** — immutable per-action audit log; one row per admin operation regardless of domain.
- **Admin queue** — unified inbox of pending items across all moderation sources.
- **REPEATABLE READ** — PostgreSQL transaction isolation level used to bind multiple reads to a single transaction snapshot.

## 3. Requirements, Constraints & Guidelines

### Requirements

- **REQ-001** — Unified queue aggregates 10 sources via UNION ALL at read time: `admin_notifications`, `kyc_verifications WHERE status='submitted'`, `listings WHERE status='in_review'`, `dispute_escalations WHERE status NOT IN ('resolved','dismissed')`, `payout_requests WHERE status='manual_review'`, `chargebacks WHERE status IN ('received','arbitration')`, `reconciliation_discrepancies WHERE status='open'`, `category_proposals WHERE status='pending'`, `message_reports WHERE status='pending'`, `review_reports WHERE status='pending'`.
- **REQ-002** — Queue pagination uses compound keyset cursor `(created_at ASC, id ASC)` only. Severity is a FILTER parameter (`?severity=high|medium|low`), NOT in ORDER BY.
- **REQ-003** — Audit timeline UNION sources: `audit_events` (filter on `actor_user_id` or `target_user_id`), `deal_events` (filter on `actor_id` for admin actions; alias `actor_id AS admin_user_id` in projection), `kyc_review_events` (filter on `provider_id`), `ledger_entries` joined to `ledger_accounts ON account_id WHERE ledger_accounts.owner_id = $user_id`, `admin_actions` (filter on denormalized `user_id`).
- **REQ-004** — `admin_audit_search_index` projection table populated by a dedicated `audit_search_consumer` worker (own cursor in `notification_consumer_cursors`-shaped table). Worker single-active via `FOR UPDATE SKIP LOCKED` on cursor row.
- **REQ-005** — `admin_actions.user_id UUID` denormalized column populated at write time from action context (not necessarily equal to `target_id`). Index `(user_id, created_at DESC) WHERE user_id IS NOT NULL`.
- **REQ-006** — `admin_actions` is immutable: PG REVOKE UPDATE, DELETE FROM application_role (mirrors KYC SEC-006). Direct superuser access outside threat model; pgaudit logging recommended.
- **REQ-007** — Admin sessions: max duration 4 hours, idle timeout 30 minutes. Stored in `admin_sessions` table separate from `auth_sessions`. FK `auth_session_id REFERENCES auth_sessions(id) ON DELETE CASCADE`.
- **REQ-008** — Session middleware uses split read/write: plain SELECT for authorization check, fire-and-forget UPDATE for `last_activity_at` heartbeat (outside main TX). NO `FOR UPDATE` on session row per request.
- **REQ-009** — High-impact actions require `X-Admin-Mfa-Token: <challenge_uuid>` header. Token consumed atomically (`UPDATE admin_mfa_challenges SET used_at=now() WHERE id=$ AND used_at IS NULL`). 5-minute TTL.
- **REQ-010** — Bulk operations: max 10 target IDs per operation (DB CHECK). Irreversible bulk ops require 4-eyes approval (DB CHECK `approved_by IS NULL OR approved_by <> initiated_by`).
- **REQ-011** — User detail snapshot endpoint executes 6+ reads inside a single `BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; ... COMMIT;` block.
- **REQ-012** — RBAC matrix is seeded into `admin_permissions(role, permission) PK`. Middleware checks permission per request. New endpoints default to permission-denied unless explicitly added to the matrix (secure-by-default).
- **REQ-013** — Admin Tooling does NOT emit outbox events. User-facing notifications triggered by admin actions are emitted by the producing module (e.g., Auth `user.suspended`, KYC `kyc.rejected`, Listings `listing.archived`).
- **REQ-014** — `audit_search_consumer_cursor_lag_seconds` Prometheus gauge with P3 alert threshold at >60 s for 10 minutes (NEW-1 mitigation).
- **REQ-015** — Single-action rate limit: max 10 admin actions per minute per admin (Redis sliding window). Bulk operations count as one action regardless of target count.

### Security

- **ADM-SEC-001** — All `/admin/*` requests authenticate via JWT and additionally verify the user's role from `user_roles` re-read (mirrors Auth SEC-006). JWT claims MUST NOT be sole authority.
- **ADM-SEC-002** — High-impact actions require fresh MFA challenge (REQ-009). The challenge is single-use and session-bound; cross-session token replay returns 403.
- **ADM-SEC-003** — `support` role receives column-level projection on `GET /admin/actions`: `payload`, `reason`, `ip`, `user_agent` are stripped. Permission `audit:admin_actions_full` required for unprojected read; granted only to `admin` role.
- **ADM-SEC-004** — Moderator role's exclusion from KYC, financial, and dispute-resolution actions is enforced by absence in `admin_permissions` seed rows. New endpoints inherit secure-by-default (permission-denied unless seed row added).
- **ADM-SEC-005** — `admin_actions` UPDATE and DELETE permissions REVOKED from application_role at the GRANT layer (mirrors KYC SEC-006). PG RULE-based immutability rejected as bypassable via `pg_rewrite`.
- **ADM-SEC-006** — KMS-degraded mode (`admin_kms_degraded` feature flag): high-impact MFA-required actions return `503 admin_mfa_unavailable` with `Retry-After: 60`. Read operations and non-MFA writes proceed normally. TOTP secrets are NEVER cached in process memory.
- **ADM-SEC-007** — Bulk operation 4-eyes: `chk_bulk_4eyes CHECK (approved_by IS NULL OR approved_by <> initiated_by)` enforced at DB level. Application-layer enforcement is defense-in-depth, not the sole barrier.
- **ADM-SEC-008** — Admin sessions max 4h / idle 30min; deviations require explicit re-authentication (no "remember me").

### Constraints

- **ADM-CON-001** — Admin Tooling has no production prerequisites beyond Modules 1–11 already finalized. No v1.x amendment required for other specs.
- **ADM-CON-002** — `admin_audit_search_index` is eventually consistent (consumer cursor lag). FTS results carry an implicit staleness window of up to 60s under normal load. Expose lag gauge per REQ-014.
- **ADM-CON-003** — `admin_kms_degraded` flag check happens at the start of each request (route guard). Mid-request degradation does not affect in-flight operations; the flag is checked once.
- **ADM-CON-004** — REPEATABLE READ snapshot in user detail endpoint is informational only. Mutation endpoints MUST perform their own per-mutation re-reads (SEC-006 pattern) — do not rely on snapshot data for mutation decisions.
- **ADM-CON-005** — `admin_actions` retention: 7 years (financial-record class; admin actions on payouts/chargebacks/deals are evidence in regulatory audits). NULL-on-erase for GDPR (NULL `payload`, `reason`, `ip`, `user_agent`; retain row for ledger integrity).
- **ADM-CON-006** — Bulk operations: max 10 targets/op (DB CHECK), max 10/min/admin (Redis rate limit).
- **ADM-CON-007** — Admin tooling does not author domain mutation endpoints. All state-changing operations (suspend, KYC approve, payout approve, etc.) live in their owning modules; Admin Tooling references them.

### Guidelines

- **ADM-GUD-001** — When adding a new admin-facing endpoint to a domain module, the corresponding permission MUST be added to the `admin_permissions` seed at the same migration. Default-deny on missing rows is the secure-by-default posture.
- **ADM-GUD-002** — When adding a new high-impact action, declare it in the MFA-required action enum AND in the producing module's outbox catalog if user notification is required.
- **ADM-GUD-003** — Severity heuristic in the unified queue is informational only. Do not gate critical operations on severity classification — use explicit `notification_code` or source-table-specific filters.
- **ADM-GUD-004** — Idle-timeout window of 30 minutes balances admin convenience against session-hijack risk. Adjust only with documented threat-model rationale.

### Patterns

- **ADM-PAT-001** — Read-time UNION aggregation for queue and audit timeline; no denormalized projection tables for these (FTS index is the exception).
- **ADM-PAT-002** — Single-use MFA challenge token: `UPDATE ... SET used_at=now() WHERE id=$ AND used_at IS NULL` returning row count 1 for valid; 0 for replay/expired.
- **ADM-PAT-003** — Split read/write session middleware: SELECT for auth check, fire-and-forget UPDATE for heartbeat.
- **ADM-PAT-004** — REPEATABLE READ wrap for multi-read snapshot endpoints.
- **ADM-PAT-005** — Field-mask projection at service layer based on resolved permission for column-level access control.

## 4. Interfaces & Data Contracts

### 4.1 Schema

```sql
-- 4.1.1 RBAC matrix (seeded via migrations)
CREATE TABLE admin_permissions (
  role       TEXT NOT NULL CHECK (role IN ('admin','moderator','support')),
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT INTO admin_permissions (role, permission) VALUES
  -- admin: full set
  ('admin','queue:view'),('admin','queue:claim'),('admin','queue:ack'),
  ('admin','kyc:review'),('admin','listing:moderate'),('admin','review:moderate'),
  ('admin','message:moderate'),('admin','media:inspect'),('admin','deal:resolve'),
  ('admin','payment:approve_payout'),('admin','payment:resolve_chargeback'),
  ('admin','payment:view_ledger'),('admin','user:search'),('admin','user:view'),
  ('admin','user:suspend'),('admin','user:unsuspend'),('admin','category:moderate'),
  ('admin','audit:read'),('admin','audit:admin_actions_full'),
  ('admin','promotion:manage'),('admin','bulk:execute'),
  -- moderator: content-only
  ('moderator','queue:view'),('moderator','queue:claim'),('moderator','queue:ack'),
  ('moderator','listing:moderate'),('moderator','review:moderate'),
  ('moderator','message:moderate'),('moderator','media:inspect'),
  ('moderator','user:search'),('moderator','user:view'),('moderator','audit:read'),
  -- support: read-only audit + user search + queue view
  ('support','queue:view'),('support','user:search'),('support','user:view'),
  ('support','audit:read')
ON CONFLICT DO NOTHING;

-- 4.1.2 Admin sessions (separate from auth_sessions, stricter policy)
CREATE TABLE admin_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_session_id  UUID        NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '4 hours',
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip               INET,
  user_agent       TEXT,
  revoked_at       TIMESTAMPTZ,
  revoke_reason    TEXT       -- 'idle_timeout','max_duration','manual','mfa_stale'
);
CREATE UNIQUE INDEX uq_admin_sessions_auth      ON admin_sessions (auth_session_id);
CREATE INDEX        idx_admin_sessions_admin    ON admin_sessions (admin_id, last_activity_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX        idx_admin_sessions_expires  ON admin_sessions (expires_at) WHERE revoked_at IS NULL;

-- 4.1.3 MFA challenge tokens
CREATE TABLE admin_mfa_challenges (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  UUID        NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '5 minutes',
  used_at     TIMESTAMPTZ,
  action_type TEXT        NOT NULL
);
CREATE INDEX idx_mfa_challenge_active ON admin_mfa_challenges (user_id, expires_at)
  WHERE used_at IS NULL;

-- 4.1.4 admin_actions — immutable audit log
CREATE TABLE admin_actions (
  id           BIGSERIAL   PRIMARY KEY,
  admin_id     UUID        NOT NULL REFERENCES users(id),
  admin_role   TEXT        NOT NULL,
  action_type  TEXT        NOT NULL,
  target_type  TEXT        NOT NULL,           -- 'user','kyc','listing','review','message','deal','payment','category','media','promotion'
  target_id    TEXT        NOT NULL,
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,  -- denormalized: affected user (REQ-005)
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason       TEXT,
  mfa_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_actions_admin   ON admin_actions (admin_id, created_at DESC);
CREATE INDEX idx_admin_actions_target  ON admin_actions (target_type, target_id, created_at DESC);
CREATE INDEX idx_admin_actions_type    ON admin_actions (action_type, created_at DESC);
CREATE INDEX idx_admin_actions_user    ON admin_actions (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ADM-SEC-005: REVOKE UPDATE, DELETE on admin_actions from application_role
-- (application_role retains INSERT, SELECT only)
REVOKE UPDATE, DELETE ON admin_actions FROM application_role;

-- 4.1.5 admin_bulk_operations
CREATE TABLE admin_bulk_operations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  initiated_by    UUID        NOT NULL REFERENCES users(id),
  operation_type  TEXT        NOT NULL,
  target_ids      TEXT[]      NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','awaiting_approval','in_progress','completed','failed','cancelled')),
  approved_by     UUID        REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_detail    TEXT,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  mfa_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bulk_target_count CHECK (cardinality(target_ids) BETWEEN 1 AND 10),
  CONSTRAINT chk_bulk_4eyes CHECK (approved_by IS NULL OR approved_by <> initiated_by)
);
CREATE INDEX idx_bulk_ops_initiator ON admin_bulk_operations (initiated_by, created_at DESC);
CREATE INDEX idx_bulk_ops_pending   ON admin_bulk_operations (created_at) WHERE status IN ('pending','awaiting_approval');

-- 4.1.6 admin_audit_search_index — FTS projection (NEW-1 fix)
CREATE TABLE admin_audit_search_index (
  audit_event_id  BIGINT      NOT NULL,
  partition_month DATE        NOT NULL,
  search_vector   TSVECTOR    NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (audit_event_id, partition_month)
);
CREATE INDEX idx_audit_search_fts  ON admin_audit_search_index USING GIN (search_vector);
CREATE INDEX idx_audit_search_time ON admin_audit_search_index (created_at DESC);

-- 4.1.7 audit_search_consumer cursor (own outbox-style consumer)
CREATE TABLE audit_search_consumer_cursors (
  consumer_name TEXT        PRIMARY KEY,
  last_seen_id  BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO audit_search_consumer_cursors (consumer_name) VALUES ('audit_search_worker') ON CONFLICT DO NOTHING;
```

### 4.2 Unified Queue Aggregation

```sql
-- GET /admin/queue?type=&severity=&age_gt_minutes=&cursor=&limit=
-- Pagination: keyset (created_at ASC, id ASC). Severity is FILTER only.
WITH q AS (

  -- (a) admin_notifications
  SELECT an.id::text          AS item_id,
         'admin_notifications' AS source_table,
         an.notification_code  AS item_type,
         CASE
           WHEN an.notification_code IN ('deal_dispute_escalated_admin','media_scan_threat_for_uploader') THEN 'high'
           WHEN an.notification_code IN ('kyc_submitted_admin','listing_reported_admin','listing_appeal_filed_admin','review_reported_admin','category_proposed_admin','message_reported_admin') THEN 'medium'
           ELSE 'low'
         END                   AS severity,
         EXTRACT(EPOCH FROM (now() - an.created_at)) / 60 AS age_minutes,
         an.status,
         an.payload,
         an.created_at
  FROM admin_notifications an
  WHERE an.status IN ('unclaimed','claimed')

  UNION ALL

  -- (b) kyc_verifications submitted
  SELECT kv.id::text, 'kyc_verifications', 'kyc.submitted', 'medium',
         EXTRACT(EPOCH FROM (now() - kv.submitted_at)) / 60, kv.status::text,
         jsonb_build_object('provider_id', kv.provider_id), kv.submitted_at
  FROM kyc_verifications kv WHERE kv.status = 'submitted'

  UNION ALL

  -- (c) listings in_review
  SELECT l.id::text, 'listings', 'listing.submitted_for_review', 'medium',
         EXTRACT(EPOCH FROM (now() - l.submitted_at)) / 60, l.status::text,
         jsonb_build_object('listing_id', l.id, 'provider_id', l.provider_id), l.submitted_at
  FROM listings l WHERE l.status = 'in_review'

  UNION ALL

  -- (d) dispute_escalations
  SELECT de.id::text, 'dispute_escalations', 'deal.dispute_escalated', 'high',
         EXTRACT(EPOCH FROM (now() - de.escalated_at)) / 60, de.status::text,
         jsonb_build_object('deal_id', de.deal_id), de.escalated_at
  FROM dispute_escalations de WHERE de.status NOT IN ('resolved','dismissed')

  UNION ALL

  -- (e) payout manual review
  SELECT pr.id::text, 'payout_requests', 'payment.payout_manual_review', 'high',
         EXTRACT(EPOCH FROM (now() - pr.created_at)) / 60, pr.status::text,
         jsonb_build_object('provider_id', pr.provider_id, 'amount_kopecks', pr.amount_kopecks),
         pr.created_at
  FROM payout_requests pr WHERE pr.status = 'manual_review'

  UNION ALL

  -- (f) chargebacks open
  SELECT cb.id::text, 'chargebacks', 'payment.chargeback', 'high',
         EXTRACT(EPOCH FROM (now() - cb.created_at)) / 60, cb.status::text,
         jsonb_build_object('deal_id', cb.deal_id, 'amount_kopecks', cb.amount_kopecks),
         cb.created_at
  FROM chargebacks cb WHERE cb.status IN ('received','arbitration')

  UNION ALL

  -- (g) reconciliation discrepancies open
  SELECT rd.id::text, 'reconciliation_discrepancies', 'payment.reconciliation_discrepancy', 'medium',
         EXTRACT(EPOCH FROM (now() - rd.created_at)) / 60, rd.status::text,
         jsonb_build_object('discrepancy_type', rd.discrepancy_type), rd.created_at
  FROM reconciliation_discrepancies rd WHERE rd.status = 'open'

  UNION ALL

  -- (h) category_proposals pending (REFINED R5: correct table + columns)
  SELECT cp.id::text, 'category_proposals', 'category.proposed', 'low',
         EXTRACT(EPOCH FROM (now() - cp.created_at)) / 60, cp.status::text,
         jsonb_build_object('proposed_name', cp.proposed_name, 'proposer_id', cp.proposer_id),
         cp.created_at
  FROM category_proposals cp WHERE cp.status = 'pending'

  UNION ALL

  -- (i) message_reports pending
  SELECT mr.id::text, 'message_reports', 'message.reported', 'medium',
         EXTRACT(EPOCH FROM (now() - mr.created_at)) / 60, mr.status::text,
         jsonb_build_object('message_id', mr.message_id), mr.created_at
  FROM message_reports mr WHERE mr.status = 'pending'

  UNION ALL

  -- (j) review_reports pending
  SELECT rr.id::text, 'review_reports', 'review.reported', 'medium',
         EXTRACT(EPOCH FROM (now() - rr.created_at)) / 60, rr.status::text,
         jsonb_build_object('review_id', rr.review_id), rr.created_at
  FROM review_reports rr WHERE rr.status = 'pending'

)
SELECT *
FROM q
WHERE ($type     IS NULL OR item_type = $type)
  AND ($severity IS NULL OR severity  = $severity)
  AND ($age_gt   IS NULL OR age_minutes >= $age_gt)
  AND ($cursor_ts IS NULL OR (created_at, item_id) > ($cursor_ts, $cursor_id))
ORDER BY created_at ASC, item_id ASC
LIMIT $limit;
```

### 4.3 Cross-Domain Audit Timeline

```sql
-- GET /admin/audit/timeline?user_id=X&from=&to=&domain=&cursor=&limit=
WITH t AS (

  -- (a) audit_events
  SELECT 'auth' AS domain, ae.id::text AS event_id, ae.event_type,
         ae.actor_user_id, ae.target_user_id AS subject_user_id,
         ae.metadata AS detail, ae.created_at
  FROM audit_events ae
  WHERE (ae.actor_user_id = $user_id OR ae.target_user_id = $user_id)
    AND ae.created_at BETWEEN $from AND $to

  UNION ALL

  -- (b) deal_events (REFINED R1: actor_id, projected as admin_user_id)
  SELECT 'deal', de.id::text, de.event_type,
         de.actor_id AS actor_user_id,
         COALESCE(d.client_id, d.provider_id) AS subject_user_id,
         de.metadata, de.created_at
  FROM deal_events de
  JOIN deals d ON d.id = de.deal_id
  WHERE (d.client_id = $user_id OR d.provider_id = $user_id)
    AND de.created_at BETWEEN $from AND $to

  UNION ALL

  -- (c) kyc_review_events (REFINED R2: provider_id)
  SELECT 'kyc', kre.id::text, kre.event_type,
         kre.actor_id AS actor_user_id, kre.provider_id AS subject_user_id,
         kre.detail, kre.created_at
  FROM kyc_review_events kre
  WHERE kre.provider_id = $user_id
    AND kre.created_at BETWEEN $from AND $to

  UNION ALL

  -- (d) ledger_entries (REFINED R4: two-hop join via ledger_accounts.owner_id)
  SELECT 'payment', le.id::text, le.direction::text,
         NULL::uuid AS actor_user_id, la.owner_id AS subject_user_id,
         jsonb_build_object('amount_kopecks', le.amount_kopecks,
                            'account_type', la.account_type,
                            'txn_group_id', le.txn_group_id),
         le.created_at
  FROM ledger_entries le
  JOIN ledger_accounts la ON la.id = le.account_id
  WHERE la.owner_id = $user_id
    AND la.account_type = 'user_wallet'
    AND le.created_at BETWEEN $from AND $to

  UNION ALL

  -- (e) admin_actions (REFINED R9: filter on denormalized user_id, not target_id)
  SELECT 'admin_action', aa.id::text, aa.action_type,
         aa.admin_id AS actor_user_id, aa.user_id AS subject_user_id,
         aa.payload, aa.created_at
  FROM admin_actions aa
  WHERE aa.user_id = $user_id
    AND aa.created_at BETWEEN $from AND $to

)
SELECT *
FROM t
WHERE ($domain IS NULL OR domain = $domain)
  AND ($cursor_ts IS NULL OR (created_at, event_id) < ($cursor_ts, $cursor_id))
ORDER BY created_at DESC, event_id DESC
LIMIT $limit;
```

### 4.4 FTS via `admin_audit_search_index`

```sql
-- audit_search_consumer worker (runs every 5s)
BEGIN;
SELECT last_seen_id FROM audit_search_consumer_cursors
WHERE consumer_name = 'audit_search_worker' FOR UPDATE SKIP LOCKED;
-- 0 rows → COMMIT, sleep 5s, retry.

-- Scan new audit_events:
SELECT id, event_type, metadata, created_at
FROM audit_events
WHERE id > $last_seen
ORDER BY id ASC LIMIT 1000;

-- For each: INSERT INTO admin_audit_search_index
--   (audit_event_id, partition_month, search_vector, created_at)
--   VALUES (..., date_trunc('month', created_at)::date,
--           to_tsvector('simple', event_type || ' ' || COALESCE(metadata::text, '')),
--           created_at)
--   ON CONFLICT (audit_event_id, partition_month) DO NOTHING;

UPDATE audit_search_consumer_cursors SET last_seen_id = $max, updated_at = now()
WHERE consumer_name = 'audit_search_worker';
COMMIT;

-- Read query: GET /admin/audit/events?q=text
SELECT ae.*
FROM admin_audit_search_index asi
JOIN audit_events ae ON ae.id = asi.audit_event_id
WHERE asi.search_vector @@ plainto_tsquery('simple', $q)
  AND asi.created_at BETWEEN COALESCE($from, now() - INTERVAL '90 days') AND COALESCE($to, now())
ORDER BY asi.created_at DESC
LIMIT $limit;
```

### 4.5 MFA Challenge Flow

```text
Step 1 — Admin requests challenge:
  POST /admin/mfa/challenge { totp_code, action_type }
  Server:
    a. Check admin_kms_degraded flag → if set, return 503 admin_mfa_unavailable.
    b. Decrypt users.mfa_secret_enc via KMS, verify TOTP.
    c. INSERT admin_mfa_challenges (user_id, session_id, action_type, expires_at=now()+5min) RETURNING id.
    d. Return { mfa_token: id, expires_at }.

Step 2 — Admin executes high-impact action with header:
  POST /admin/users/{id}/suspend
  Header: X-Admin-Mfa-Token: <challenge_uuid>
  Server (in same TX as the action):
    a. UPDATE admin_mfa_challenges SET used_at = now()
       WHERE id = $token AND user_id = jwt.sub AND used_at IS NULL AND expires_at > now()
       RETURNING action_type, session_id;
    b. 0 rows → 403 mfa_required.
    c. Verify session_id matches current admin_sessions.id.
    d. Execute the action. Append to admin_actions with mfa_verified=true.
```

### 4.6 Session Middleware (Split Read/Write)

```text
On every /admin/* request (except /admin/session/start):
  1. Plain SELECT admin_sessions WHERE id = $sid AND revoked_at IS NULL — no lock.
  2. If not found → 401.
  3. If expires_at <= now() → revoke (revoke_reason='max_duration') in separate TX → 401.
  4. If now() - last_activity_at > 30 min → revoke (revoke_reason='idle_timeout') → 401.
  5. JWT claim revalidation: re-read user_roles from DB (ADM-SEC-001).
  6. Process request.
  7. AFTER request returns: fire-and-forget UPDATE admin_sessions SET last_activity_at=now() WHERE id=$sid (outside main TX).

Idle-timeout drift: max ~1 request window. Acceptable against 30-minute threshold.
```

### 4.7 REST API

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/admin/queue` | `queue:view` | Unified inbox (REQ-001/002) |
| GET | `/api/v1/admin/queue/stats` | `queue:view` | Counts by type/severity/age |
| POST | `/api/v1/admin/notifications/{id}/claim` | `queue:claim` | Atomic claim (Module 9) |
| POST | `/api/v1/admin/notifications/{id}/ack` | `queue:ack` | Acknowledge |
| GET | `/api/v1/admin/audit/timeline` | `audit:read` | Cross-domain timeline (REQ-003) |
| GET | `/api/v1/admin/audit/events` | `audit:read` | FTS search (§4.4) |
| GET | `/api/v1/admin/audit/deal-events/{deal_id}` | `audit:read` | deal_events log |
| GET | `/api/v1/admin/audit/kyc-log/{kyc_id}` | `kyc:review` | kyc_review_events |
| GET | `/api/v1/admin/audit/ledger/{user_id}` | `payment:view_ledger` | ledger entries |
| GET | `/api/v1/admin/audit/admin-actions` | `audit:read` (+ `audit:admin_actions_full` for unprojected fields) | admin_actions log |
| POST | `/api/v1/admin/users/search` | `user:search` | Multi-field search |
| GET | `/api/v1/admin/users/{id}` | `user:view` | Denormalized snapshot (REPEATABLE READ TX) |
| POST | `/api/v1/admin/users/{id}/suspend` | `user:suspend` + MFA | Suspend account |
| POST | `/api/v1/admin/users/{id}/unsuspend` | `user:unsuspend` + MFA | Lift suspension |
| POST | `/api/v1/admin/users/{id}/roles` | `admin` only + MFA | Grant/revoke role |
| POST | `/api/v1/admin/mfa/challenge` | admin session | Request fresh MFA token |
| POST | `/api/v1/admin/bulk` | `bulk:execute` + MFA | Submit bulk op |
| GET | `/api/v1/admin/bulk/{id}` | `bulk:execute` | Poll status |
| POST | `/api/v1/admin/bulk/{id}/approve` | `admin` + MFA + `<>initiator` | 4-eyes second approval |
| POST | `/api/v1/admin/bulk/{id}/cancel` | `bulk:execute` | Cancel pending |
| POST | `/api/v1/admin/session/start` | access JWT (admin/moderator/support role) | Create admin session |
| POST | `/api/v1/admin/session/heartbeat` | admin session | Ping (idempotent UPDATE) |
| POST | `/api/v1/admin/session/end` | admin session | Explicit logout |
| GET | `/api/v1/admin/promotions` | `promotion:manage` | Delegates to Feed module |
| POST | `/api/v1/admin/promotions` | `promotion:manage` + MFA | Set promotion |
| DELETE | `/api/v1/admin/promotions/{id}` | `promotion:manage` | Remove promotion |

**Domain action endpoints (referenced, NOT defined here):** `POST /admin/kyc/{id}/{approve,reject}` (KYC), `POST /admin/listings/{id}/{approve,reject,force-archive}` (Listings), `POST /admin/messages/{id}/redact` (Messaging), `POST /admin/reviews/{id}/redact` (Reviews), `POST /admin/deals/{id}/resolve` (Deal), `POST /admin/payouts/{id}/{approve,reject}` (Payments), `POST /admin/chargebacks/{id}/{submit-evidence,resolve}` (Payments), `POST /admin/categories/{id}/{approve,reject}` (Category Tree).

### 4.8 User Detail Snapshot

```sql
-- GET /admin/users/{user_id}
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

SELECT id, email, phone, status, email_verified, mfa_enabled, created_at
FROM users WHERE id = $user_id;

SELECT array_agg(role) FROM user_roles WHERE user_id = $user_id;

SELECT kyc_status, payout_enabled FROM provider_profiles WHERE user_id = $user_id;

SELECT status, approved_at FROM kyc_verifications
WHERE provider_id = $user_id ORDER BY created_at DESC LIMIT 1;

-- Wallet (REFINED R4: two-hop)
SELECT wb.available_kopecks, wb.frozen_kopecks
FROM ledger_accounts la
JOIN wallet_balances wb ON wb.account_id = la.id
WHERE la.owner_id = $user_id AND la.account_type = 'user_wallet';

-- Deal counts
SELECT
  COUNT(*) FILTER (WHERE status = 'active')    AS active,
  COUNT(*) FILTER (WHERE status = 'disputed')  AS disputed,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) AS total
FROM deals
WHERE client_id = $user_id OR provider_id = $user_id;

-- Recent admin actions on this user
SELECT id, admin_id, action_type, target_type, created_at
FROM admin_actions
WHERE user_id = $user_id
ORDER BY created_at DESC LIMIT 20;

COMMIT;
```

## 5. Acceptance Criteria

- **AC-001** — Given mixed-severity items in the queue, When admin pages with `cursor=(t1, id1)` and `severity=high`, Then results are filtered by severity in WHERE clause and ordered by `(created_at ASC, id ASC)` only; pagination is stable.
- **AC-002** — Given an admin acting on a user's deal, When the admin executes `POST /admin/deals/{id}/resolve`, Then `admin_actions` row is written with `target_type='deal'`, `target_id=deal_id`, AND `user_id` populated with the affected client/provider id (REQ-005).
- **AC-003** — Given a `GET /admin/audit/timeline?user_id=X` query, When the user has had a deal resolved by admin, Then the admin action appears in the timeline filtered on `admin_actions.user_id` (not on `target_id`).
- **AC-004** — Given `audit_events` partitioned by month, When the FTS index is created, Then no ALTER TABLE is performed on `audit_events`; the `admin_audit_search_index` projection table is populated by the consumer.
- **AC-005** — Given a search query, When the consumer is lagged by 30 s, Then the result may miss the most recent 30 s of events; the lag gauge `audit_search_consumer_cursor_lag_seconds` reflects this.
- **AC-006** — Given an admin's `auth_session` is deleted by the cleanup job, When the FK ON DELETE CASCADE fires, Then the corresponding `admin_sessions` row is deleted without error.
- **AC-007** — Given two concurrent `/admin/queue` requests from the same admin, When both are in flight, Then neither request blocks the other on `admin_sessions FOR UPDATE` (split read/write per ADM-PAT-003).
- **AC-008** — Given KMS is degraded, When admin attempts `POST /admin/users/{id}/suspend`, Then response is `503 admin_mfa_unavailable` with `Retry-After: 60`. `GET /admin/queue` proceeds normally.
- **AC-009** — Given an admin attempts to self-approve a bulk operation (`approved_by = initiated_by`), When the row is written, Then DB CHECK `chk_bulk_4eyes` rejects with constraint violation.
- **AC-010** — Given `support` role calls `GET /admin/audit/admin-actions`, When the response is built, Then `payload`, `reason`, `ip`, `user_agent` are stripped (column-level projection per ADM-SEC-003).
- **AC-011** — Given an admin tries to UPDATE or DELETE a row in `admin_actions` via the application connection, When the DML is executed, Then PostgreSQL rejects with permission denied (REVOKE applied per ADM-SEC-005).
- **AC-012** — Given an MFA challenge issued at T0, When admin uses it at T0+6min, Then `expires_at < now()` and the action returns `403 mfa_required`.
- **AC-013** — Given an MFA challenge consumed once, When admin replays the same token, Then `used_at IS NOT NULL` and the action returns `403 mfa_required`.
- **AC-014** — Given a moderator calls `POST /admin/users/{id}/suspend`, When permission check runs, Then 403 returned because `moderator` lacks `user:suspend` in the matrix (secure-by-default per ADM-SEC-004).
- **AC-015** — Given an admin user-detail snapshot fetch under concurrent KYC approval, When the read transaction is REPEATABLE READ, Then all 6 SELECTs see the same snapshot from before or after the concurrent commit, never a torn read.
- **AC-016** — Given a session at 3h 59min (within 4h max), When a request arrives, Then it succeeds and `last_activity_at` is updated. At 4h 00min: next request returns 401 `session_expired`.
- **AC-017** — Given a session idle for 31 min, When a request arrives, Then the middleware revokes with `revoke_reason='idle_timeout'` and returns 401.
- **AC-018** — Given a bulk op with 11 target_ids, When INSERT is attempted, Then DB CHECK `chk_bulk_target_count` rejects.

## 6. Test Automation Strategy

- **Test Levels:** Unit (permission resolution, MFA challenge consumption, severity heuristic, projection logic for support role), Integration (queue UNION query against seeded fixtures from all 10 sources, audit timeline cross-domain joins, audit search consumer cursor lag), End-to-End (full admin session lifecycle, bulk op 4-eyes, MFA challenge flow with KMS degraded scenario).
- **Frameworks:** project-default backend test stack.
- **Test Data:** seeded admin/moderator/support users with `user_roles` rows; seeded `admin_permissions`; mock `auth_sessions` linkage; concurrent-request fixtures for split read/write session middleware.
- **CI/CD:** integration tests run on every PR. KMS-degraded simulation toggles the feature flag. Permission-matrix tests assert each role's endpoint access list against `admin_permissions` seed (no per-endpoint hardcoding).
- **Coverage:** ≥85% line coverage on Admin Tooling service.
- **Performance:** queue UNION with 10k pending items returns within 500ms p99. Audit timeline with 90d window per user returns within 1s p99.
- **Security tests:** REVOKE enforcement on `admin_actions` (attempt UPDATE as application_role → must fail). 4-eyes CHECK constraint test (attempt self-approve → must fail). MFA replay test (consumed token → must fail).

## 7. Rationale & Context

**Why a separate `admin_sessions` table:** `auth_sessions` carries 30-day TTL semantics for users. Admin policy (4h max, 30min idle, mandatory MFA-enrolled, role re-read per request) is structurally incompatible with the user session model. A separate table makes the stricter policy auditable in isolation and avoids conditional branching in shared session code.

**Why split read/write session middleware (REFINED R7):** `FOR UPDATE` on the session row serializes all concurrent admin requests through a queue, making the admin panel single-threaded per session. Plain SELECT for auth check + fire-and-forget UPDATE for heartbeat eliminates serialization at the cost of ~1-request drift on `last_activity_at` — irrelevant against a 30-minute idle window.

**Why `admin_audit_search_index` projection table (REFINED R3):** GENERATED STORED columns on partitioned tables in PG 15 require ALTER on every partition; on a busy `audit_events` table this is hours of exclusive lock. A separate projection table populated asynchronously avoids retroactive ALTER, allows independent re-indexing and language tuning, and produces clean lag metrics. Tradeoff: FTS results are eventually consistent (NEW-1); we expose the lag gauge per REQ-014.

**Why denormalized `admin_actions.user_id` (REFINED R9):** Filtering admin actions by `target_id = user_id::text` misses actions on the user's deals, listings, messages where `target_type` is the secondary entity. Denormalizing the affected user at write time produces a cheap index scan for per-user timeline queries without runtime JOINs.

**Why DB CHECK for 4-eyes (REFINED R10):** Application-layer enforcement is bypassable via direct DB access, code path bugs, and future endpoints that skip validation. The DB CHECK provides defense-in-depth at zero runtime cost.

**Why no admin.* outbox events (REFINED R11):** No registered consumer exists; emitting unconsumed events to the shared outbox creates DLQ pollution and relay-worker failures. User-facing notifications already flow from the producing module's own typed events (Auth `user.suspended`, etc.). The `admin_actions` table is the audit log; no secondary emission needed.

**Why REVOKE over PG RULE (REFINED R14):** PG RULEs are bypassable via `pg_rewrite` privilege manipulation. GRANT/REVOKE is enforced at the relation-permission layer and cannot be bypassed by the application role. KYC SEC-006 already uses this pattern; we mirror it.

**Why REPEATABLE READ for user-detail (REFINED R15):** READ COMMITTED produces torn reads across 6 SELECTs spanning concurrent state changes. REPEATABLE READ binds all reads to a single snapshot. Serializable not needed (read-only). Cost: one extra round-trip for transaction setup; admin reads are low-frequency.

**Why `support` role tier:** Customer-facing ops staff need user lookup and audit visibility but must not touch content or money. Adding `support` is additive (seed rows in `user_roles` and `admin_permissions`) with no schema change. Avoids over-granting `moderator` to support staff who would gain content moderation rights they should not have.

**Why severity is a FILTER not ORDER BY (REFINED R13):** Keyset pagination requires a stable, dense ordering; severity is sparse and non-monotonic, producing unpredictable cursor gaps. Severity-grouped tabs in the UI are implemented as separate paginated requests with `?severity=` filter.

**Why MFA TOTP secret never cached:** Per OWASP cryptographic storage guidance, decrypted key material must not persist in process heap beyond the single verification call. Caching introduces breach surface for memory dumps and core dumps. KMS-degraded fallback is 503 + Retry-After, not a cache bypass.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** — KMS (cloud provider, e.g., AWS KMS / GCP KMS) — for TOTP secret decryption during MFA challenge.

### Third-Party Services
- **SVC-001** — Prometheus / monitoring stack for `audit_search_consumer_cursor_lag_seconds` and other admin metrics.

### Infrastructure Dependencies
- **INF-001** — PostgreSQL 15+ shared cluster.
- **INF-002** — Redis 7+ for admin rate limits.
- **INF-003** — pgaudit extension recommended for superuser auditing of `admin_actions` table.

### Data Dependencies
- **DAT-001** — `audit_events` (Auth §4.1), `deal_events` (Deal §4.2), `kyc_review_events` (KYC §4.3), `ledger_entries` + `ledger_accounts` (Payments §4.1.3-4), `admin_notifications` (Notifications §4.1.10), domain queue tables (per-module status fields).
- **DAT-002** — `users`, `user_roles`, `auth_sessions`, `provider_profiles`, `kyc_verifications` for lookup and session linkage.

### Technology Platform Dependencies
- **PLT-001** — PostgreSQL 15+ for partitioned tables (audit_events) and generated stored columns.
- **PLT-002** — `pg_cron` or platform scheduler for retention sweeps.

### Compliance Dependencies
- **COM-001** — GDPR Art. 6(1)(c) — admin_actions retention 7 years for legal-obligation basis (financial-record class actions).
- **COM-002** — GDPR Art. 17 — NULL-on-erase for `admin_actions` PII columns (payload, reason, ip, user_agent) on user GDPR erasure; row retained for ledger/audit integrity.
- **COM-003** — Ukrainian "Закон про захист персональних даних" — same scope.

## 9. Examples & Edge Cases

### 9.1 Permission denial response

```json
GET /api/v1/admin/audit/admin-actions  (called by support role)

200 OK
{
  "items": [
    {
      "id": 12345,
      "action_type": "user.suspend",
      "target_type": "user",
      "admin_role": "admin",
      "created_at": "2026-05-08T10:00:00Z"
      // payload, reason, ip, user_agent stripped (ADM-SEC-003)
    }
  ]
}
```

### 9.2 4-eyes self-approval rejection

```sql
UPDATE admin_bulk_operations
SET status = 'in_progress',
    approved_by = '11111111-1111-1111-1111-111111111111',
    approved_at = now()
WHERE id = 'bulk-op-uuid'
  AND initiated_by = '11111111-1111-1111-1111-111111111111';
-- ERROR: new row violates check constraint "chk_bulk_4eyes"
```

### 9.3 Edge case — MFA challenge race

Two `/admin/users/{id}/suspend` calls with the same `X-Admin-Mfa-Token`:
- First: `UPDATE admin_mfa_challenges ... RETURNING action_type` returns 1 row → action proceeds.
- Second (concurrent): same UPDATE → 0 rows (used_at already set) → 403 `mfa_required`.

The atomic single-statement UPDATE serves as the consume-token primitive.

### 9.4 Edge case — admin session expiry mid-request

Admin's session has `expires_at = now() + 1 minute`. They submit a long-running bulk op. Session middleware checks `expires_at` at request entry; if valid, the request proceeds even if `expires_at` passes during processing. The next request after the bulk completes will return 401 `session_expired`.

## 10. Validation Criteria

A compliant implementation MUST:

1. Pass AC-001 through AC-018 in CI.
2. Reject any code path that adds an admin endpoint without a corresponding `admin_permissions` seed row (secure-by-default test).
3. Reject any code path that issues high-impact actions without `X-Admin-Mfa-Token` validation.
4. Reject any code path that emits `admin.*` events to `outbox_events`.
5. Verify `admin_audit_search_index` consumer-cursor lag gauge is exported to Prometheus.
6. Verify the REVOKE on `admin_actions` is applied at deploy time via integration test.
7. Provide column-projection test for `support` role on every admin endpoint that returns sensitive fields.
8. Provide retention sweep tests for `admin_actions` (7-year horizon, NULL-on-erase semantics on GDPR erasure event).

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `users`, `user_roles`, `auth_sessions`, `audit_events`, MFA secret storage; mirrored REVOKE pattern for `admin_actions`.
- [`spec/spec-architecture-notifications.md`](./spec-architecture-notifications.md) — `admin_notifications` shared queue (consumed by §4.2.a); §4.6 catalog admin notification codes.
- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — `deal_events` audit log (consumed by §4.3.b); admin /resolve referenced.
- [`spec/spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — `kyc_review_events.provider_id` (consumed by §4.3.c); admin approve/reject referenced; SEC-006 REVOKE pattern.
- [`spec/spec-architecture-listings.md`](./spec-architecture-listings.md) — listing review queue.
- [`spec/spec-architecture-reviews.md`](./spec-architecture-reviews.md) — review reports queue, admin redact.
- [`spec/spec-architecture-messaging.md`](./spec-architecture-messaging.md) — message reports queue, admin redact, contact-info first-block confirmation.
- [`spec/spec-architecture-media-pipeline.md`](./spec-architecture-media-pipeline.md) — media inspection.
- [`spec/spec-architecture-payments.md`](./spec-architecture-payments.md) — manual-review payouts, chargebacks, reconciliation discrepancies, ledger audit (consumed by §4.3.d).
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — `category_proposals` (consumed by §4.2.h).
- [`spec/spec-architecture-feed.md`](./spec-architecture-feed.md) — admin promotions delegate.
