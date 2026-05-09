---
title: Notifications — Transport & Delivery Layer for Outbox Events
version: 1.3
date_created: 2026-05-08
last_updated: 2026-05-09
owner: Platform / Notifications
tags: [architecture, notifications, outbox, transport, delivery, push, email, gdpr]
---

# Introduction

Module 9 — Notifications is the transport/delivery layer that consumes outbox events emitted by all prior Robotun modules (Auth, Category Tree, Deal, KYC, Listings, Media, Reviews) and delivers user-facing notifications across in-app inbox, email, and push channels. It owns user notification preferences, device token registration, email suppression, digest batching, rate limiting, GDPR erasure of notification PII, and a shared admin notification queue.

## 1. Purpose & Scope

This specification defines:

- The set of outbox events that produce notifications and the recipient/channel/mandatory/digest classification for each.
- Data model for notifications, preferences, device tokens, email suppression, digests, delivery attempts, admin queue, and the consumer cursor.
- Consumer/worker architecture: single-active polling against the shared `outbox_events` table with PostgreSQL advisory locking.
- Per-channel delivery semantics: in-app (write-only), email (provider-abstracted, suppression-list-aware, RFC-2369 unsubscribe), push (APNs/FCM provider abstraction with heartbeat-based GC).
- Rate limiting (Redis rolling windows), quiet hours, digest sweeping.
- Idempotency model and dedup constraints.
- GDPR erasure on `user.gdpr_erased_*` events (PG-authoritative, Redis best-effort).
- API surface for the user inbox, preferences, device-token lifecycle, admin queue, and admin template preview.
- Outbox events emitted by Notifications itself for downstream observability (`notification.sent`, `notification.failed`, `notification.bounced`, `preference.updated`).

**Out of scope:** SMS, social-login auth events, in-app threading/grouping, third-party webhooks, multi-locale beyond `uk`, push rich media, push delivery receipts, email open/click tracking, admin broadcast tooling, `auth.login_new_device`, DKIM/SPF DNS configuration, Prometheus metric schemas, `deal_events` polling fallback (rejected — outbox-only consumption).

**Audience:** backend engineers, platform/SRE, mobile engineers, security/legal reviewers.

**Assumptions:** PostgreSQL 15+, Redis 7+, REST/JSON over HTTPS, UUIDs, money in integer minor units, all timestamps `TIMESTAMPTZ` UTC. The shared `outbox_events` table is defined in Category Tree spec §4.3.

## 2. Definitions

- **Outbox event** — a row in `outbox_events` written transactionally with a state mutation; the canonical inter-module integration channel.
- **In-app inbox** — durable list of notifications stored in `notifications` with `channel='in_app'`, surfaced via authenticated REST.
- **Push** — mobile push delivered via APNs HTTP/2 (iOS) or FCM v1 HTTP (Android).
- **Channel** — one of `in_app`, `email`, `push`.
- **Notification code** — compile-time string constant identifying a specific notification template/intent (e.g., `deal_disputed_as_provider`, `review_published_for_you`).
- **Mandatory notification** — security/legal-class notification that bypasses user preferences and rate caps; cannot be unsubscribed.
- **Digest** — batched delivery of multiple notification rows under a single rendered envelope, keyed by `digest_key` and a time window.
- **DLQ** — dead-letter queue; in this module, rows in `notifications` with `status='failed'` after exhausted retries.
- **APNs / FCM** — Apple Push Notification service / Firebase Cloud Messaging.
- **GDPR** — General Data Protection Regulation; erasure obligations on `user.gdpr_erased_*` events.

## 3. Requirements, Constraints & Guidelines

### Requirements

- **REQ-001** — Notifications consumes outbox events with `aggregate_type IN ('deal','review','user','message','conversation','payment','payout','refund','chargeback','wallet')` and the cross-module event types in the catalog (§4.6). The `'message'`/`'conversation'` aggregate types were added in v1.1 (Messaging Module 10); `'payment'`/`'payout'`/`'refund'`/`'chargeback'`/`'wallet'` in v1.2 (Payments Module 11). Module 14 (Disputes UI, v1.3) emits its `dispute.*` events with **`aggregate_type='deal'`** and is therefore routed via the existing `'deal'` allowlist; no new aggregate_type is added in v1.3.
- **REQ-002** — The Notifications worker MUST NOT modify `outbox_events.status`. It maintains its own cursor in `notification_consumer_cursors`.
- **REQ-003** — Idempotency: dedup constraint `UNIQUE (source_event_id, user_id, channel, notification_code)` on `notifications`.
- **REQ-004** — Worker single-activeness MUST be enforced via `SELECT ... FOR UPDATE SKIP LOCKED` on the cursor row before each scan tick.
- **REQ-005** — Retry policy: max 5 delivery attempts per notification, schedule `[immediate, +30s±10s, +5m±30s, +30m±5m, +4h±30m]`. After 5 failures: `status='failed'`, emit `notification.failed`.
- **REQ-006** — Email send MUST consult `email_suppression` (keyed by SHA-256 of lowercase email) before dispatch.
- **REQ-007** — Push token invalidation: APNs `BadDeviceToken` / FCM `UNREGISTERED` MUST set `device_tokens.invalidated_at = now()` on the responsible row.
- **REQ-008** — Heartbeat endpoint MUST be JWT-authenticated and update `last_heartbeat_at` only when `device_tokens.user_id = jwt.sub` AND `invalidated_at IS NULL`.
- **REQ-009** — `review.status_changed` handler MUST gate dispatch on `payload->>'to_status' = 'published'` only.
- **REQ-010** — Admin-targeted events produce exactly ONE row in `admin_notifications` per `(source_event_id, notification_code)` — no per-admin fan-out.
- **REQ-011** — Mandatory notifications (`is_mandatory = TRUE`) MUST bypass user preference, rate cap, quiet hours (push/email), and unsubscribe.
- **REQ-012** — On `user.gdpr_erased_*` events, the worker MUST execute the GDPR erasure transaction (§4.4) within 60 seconds of event consumption.
- **REQ-013** — Notifications MUST emit its own outbox events (`notification.sent`, `notification.failed`, `notification.bounced`, `preference.updated`) into the shared `outbox_events` table.

### Security

- **SEC-001** — Heartbeat endpoint hardened against device-token resurrection: ownership match enforced server-side; mismatch returns `404` (not `403`) to avoid leaking token existence.
- **SEC-002** — `email_suppression` MUST store only `email_hash` (SHA-256 of lowercase plaintext); raw addresses never persisted in this table.
- **SEC-003** — Notification bodies MUST NOT contain counterparty email addresses; templates audited at merge time.
- **SEC-004** — `unsubscribe` JWTs are signed (RS256), single-purpose (audience claim `notifications.unsubscribe`), expire in 30 days, and identify exactly one `(user_id, notification_code, channel)` triple.
- **SEC-005** — `POST /admin/notifications/{id}/claim` MUST be authorized by the `admin` or `moderator` role.
- **SEC-006** — Rendered notification `subject`/`body` is the snapshot at delivery time. Re-renders are forbidden after dispatch (immutable except for GDPR erasure).

### Constraints

- **CON-001** — Module 9 cannot ship before Deal spec v1.1 lands. Deal spec v1.1 MUST add the following entries to its outbox event registry §4.8: `deal.rejected`, `deal.cancel_requested`, `deal.submitted`, `deal.approved`, `deal.disputed`, `deal.dispute_resolved`, `deal.dispute_escalated`, `deal.cancelled_by_client`, `deal.cancelled_mutual`, `deal.expired_pending`, `deal.auto_completed`, `deal.dispute_unresolved`. The R2-rejected `deal_events` polling fallback is explicitly disallowed.
- **CON-002** — Templates are compile-time string constants in service code at MVP. No `notification_templates` DB table.
- **CON-003** — Locale at MVP is `uk` only. Multi-locale support is a v1.1 additive change (introduce DB table at that point).
- **CON-004** — SMS channel is rejected for v1 on cost grounds (UAH 0.25–0.50/msg). The provider abstraction allows future addition without schema change.
- **CON-005** — `notifications.body` is NULLABLE to permit GDPR scrubbing while preserving referential integrity. Render layer substitutes a localized "повідомлення видалено" string when NULL.
- **CON-006** — `source_event_id` is `BIGINT` (mirrors `outbox_events.id`); single namespace, no prefix encoding.
- **CON-007** — Redis is best-effort; PostgreSQL is authoritative for all notification state.

### Guidelines

- **GUD-001** — Prefer immediate dispatch for low-volume signals; reserve digests for high-volume events (`review.replied` daily, admin events hourly).
- **GUD-002** — Admins discover work via the inbox UI, not email. Email throttle is shared per `notification_code` — at most one email per 15-minute window across the entire admin team.
- **GUD-003** — Mobile clients should call the heartbeat endpoint on every app foreground event; servers MUST tolerate at-least-once heartbeats.
- **GUD-004** — Quiet hours apply only to push and email. In-app writes proceed regardless to preserve completeness of the inbox.
- **GUD-005** — `review.submitted` is COALESCED with `review.status_changed(to_status='published')`. Only the published-reveal produces a user-facing reveal notification (`review_published_for_you`); `review_submitted_about_you` is a content-free pre-reveal notice.

### Patterns

- **PAT-001** — Transactional outbox consumer with cursor: `WHERE id > $cursor ORDER BY id LIMIT 500`, advisory-lock the cursor row to single-thread.
- **PAT-002** — Idempotent insert: `INSERT ... ON CONFLICT (source_event_id, user_id, channel, notification_code) DO NOTHING`.
- **PAT-003** — Provider-abstracted delivery: `EmailProvider` and `PushProvider` interfaces; concrete impls are swappable via config.
- **PAT-004** — Lua-CAS for Redis counters to prevent lost updates and negative values (§4.5).

## 4. Interfaces & Data Contracts

### 4.1 Schema (PostgreSQL 15+)

```sql
-- 4.1.1 notification type registry (seed via migration)
CREATE TABLE notification_types (
  code              TEXT        PRIMARY KEY,
  channel_defaults  JSONB       NOT NULL,                     -- {"in_app":true,"email":true,"push":false}
  is_mandatory      BOOLEAN     NOT NULL DEFAULT FALSE,
  digest_eligible   BOOLEAN     NOT NULL DEFAULT FALSE,
  recipient_type    TEXT        NOT NULL CHECK (recipient_type IN ('client','provider','admin','any')),
  description       TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.1.2 per-user preferences
CREATE TABLE notification_preferences (
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_code TEXT        NOT NULL REFERENCES notification_types(code),
  channel           TEXT        NOT NULL CHECK (channel IN ('in_app','email','push')),
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_code, channel)
);
CREATE INDEX idx_notif_prefs_user ON notification_preferences (user_id);

-- 4.1.3 quiet hours / locale (extends user_profiles)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notif_quiet_start TIME;  -- e.g. '23:00'
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notif_quiet_end   TIME;  -- e.g. '08:00'
-- user_profiles.timezone (existing) is reused for TZ resolution.

-- 4.1.4 device tokens
CREATE TABLE device_tokens (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token             TEXT        NOT NULL,
  platform          TEXT        NOT NULL CHECK (platform IN ('apns','fcm')),
  app_version       TEXT,
  device_info       JSONB,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),    -- DEPRECATED, retained for audit
  last_heartbeat_at TIMESTAMPTZ,
  invalidated_at    TIMESTAMPTZ,
  CONSTRAINT uq_device_token UNIQUE (token)
);
CREATE INDEX idx_device_tokens_user        ON device_tokens (user_id) WHERE invalidated_at IS NULL;
CREATE INDEX idx_device_tokens_invalidated ON device_tokens (invalidated_at) WHERE invalidated_at IS NOT NULL;

-- 4.1.5 email suppression
CREATE TABLE email_suppression (
  email_hash    TEXT        PRIMARY KEY,
  reason        TEXT        NOT NULL CHECK (reason IN ('bounce_hard','complaint','unsubscribed','gdpr')),
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT        NOT NULL
);

-- 4.1.6 notifications (core record)
CREATE TABLE notifications (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_code   TEXT        NOT NULL REFERENCES notification_types(code),
  aggregate_type      TEXT        NOT NULL,
  aggregate_id        UUID        NOT NULL,
  source_event_id     BIGINT      NOT NULL CHECK (source_event_id > 0),  -- outbox_events.id
  channel             TEXT        NOT NULL CHECK (channel IN ('in_app','email','push')),
  subject             TEXT,
  body                TEXT,                         -- NULLABLE post-GDPR-erasure
  push_title          TEXT,
  deep_link           TEXT,
  template_vars       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  digest_key          TEXT,
  digest_sent_at      TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','delivered','failed','suppressed','skipped')),
  read_at             TIMESTAMPTZ,
  dismissed_at        TIMESTAMPTZ,
  pii_erased_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_dedup
    UNIQUE (source_event_id, recipient_user_id, channel, notification_code)
);
CREATE INDEX idx_notif_user_inbox    ON notifications (recipient_user_id, created_at DESC)
  WHERE channel = 'in_app' AND dismissed_at IS NULL;
CREATE INDEX idx_notif_user_unread   ON notifications (recipient_user_id)
  WHERE channel = 'in_app' AND read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX idx_notif_pending       ON notifications (created_at)
  WHERE status = 'pending';
CREATE INDEX idx_notif_digest_sweep  ON notifications (digest_key, created_at)
  WHERE digest_key IS NOT NULL AND digest_sent_at IS NULL;
CREATE INDEX idx_notif_aggregate     ON notifications (aggregate_type, aggregate_id);

CREATE TRIGGER set_notif_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- 4.1.7 delivery attempts
CREATE TABLE notification_delivery_attempts (
  id              BIGSERIAL   PRIMARY KEY,
  notification_id UUID        NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  attempt_number  SMALLINT    NOT NULL,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider        TEXT,
  provider_msg_id TEXT,
  outcome         TEXT        NOT NULL CHECK (outcome IN ('success','failure','bounce','complaint')),
  error_detail    TEXT,
  http_status     SMALLINT
);
CREATE INDEX idx_delivery_notif        ON notification_delivery_attempts (notification_id, attempted_at DESC);
CREATE INDEX idx_delivery_provider_msg ON notification_delivery_attempts (provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;

-- 4.1.8 digests
CREATE TABLE notification_digests (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_key       TEXT        NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  notification_ids UUID[]      NOT NULL,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_digest_pending ON notification_digests (window_end) WHERE sent_at IS NULL;

-- 4.1.9 consumer cursor (single-active enforcement target)
CREATE TABLE notification_consumer_cursors (
  consumer_name TEXT        PRIMARY KEY,
  last_seen_id  BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO notification_consumer_cursors (consumer_name) VALUES ('notifications_worker')
  ON CONFLICT DO NOTHING;

-- 4.1.10 admin shared queue
CREATE TABLE admin_notifications (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_code TEXT        NOT NULL,
  source_event_id   BIGINT      NOT NULL CHECK (source_event_id > 0),
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT        NOT NULL DEFAULT 'unclaimed'
                      CHECK (status IN ('unclaimed','claimed','acknowledged')),
  claimed_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  claimed_at        TIMESTAMPTZ,
  acknowledged_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_admin_notif_event UNIQUE (source_event_id, notification_code)
);
CREATE INDEX idx_admin_notif_unclaimed ON admin_notifications (created_at DESC) WHERE status = 'unclaimed';
```

### 4.2 Worker Scan Loop (Pseudocode + SQL)

```sql
-- One scan tick (runs every 1s):
BEGIN;

SELECT last_seen_id
FROM   notification_consumer_cursors
WHERE  consumer_name = 'notifications_worker'
FOR UPDATE SKIP LOCKED;
-- If 0 rows: another worker holds the lock. COMMIT and sleep.

-- Else, with the row locked:
SELECT id, aggregate_type, event_type, payload, created_at
FROM   outbox_events
WHERE  id > $last_seen_id
   AND aggregate_type IN ('deal','review','user','message','conversation','payment','payout','refund','chargeback','wallet')  -- v1.1: +message,+conversation; v1.2: +payment,+payout,+refund,+chargeback,+wallet; v1.3 dispute.* events ride aggregate_type='deal' (no allowlist change)
ORDER BY id ASC
LIMIT  500;

-- For each event: route → resolve recipients → INSERT INTO notifications ON CONFLICT DO NOTHING

UPDATE notification_consumer_cursors
SET    last_seen_id = $max_id_in_batch,
       updated_at   = now()
WHERE  consumer_name = 'notifications_worker';

COMMIT;
```

Multiple worker pods MAY be deployed for HA; only one acquires the cursor lock per tick.

### 4.3 Retry Schedule

| Attempt | Delay from previous | Jitter |
|---|---|---|
| 1 | immediate | — |
| 2 | +30 s | ±10 s |
| 3 | +5 min | ±30 s |
| 4 | +30 min | ±5 min |
| 5 | +4 h | ±30 min |

After attempt 5 fails: `status='failed'` and emit `notification.failed`. The `notifications` table with `status='failed'` IS the DLQ (no separate table).

### 4.4 GDPR Erasure (PG-authoritative, Redis best-effort)

Triggered by `user.gdpr_erased_reviews` (Reviews §4.8) and the future `user.gdpr_erased` event from Auth.

```sql
BEGIN;
UPDATE notifications
SET    body = NULL,
       template_vars = '{}'::jsonb,
       pii_erased_at = now(),
       updated_at = now()
WHERE  recipient_user_id = $erased_user_id
  AND  created_at > now() - INTERVAL '12 months';

DELETE FROM device_tokens
WHERE  user_id = $erased_user_id;

DELETE FROM notification_delivery_attempts
WHERE  notification_id IN (
  SELECT id FROM notifications WHERE recipient_user_id = $erased_user_id
);
COMMIT;

-- Best-effort, post-commit (failure is tolerated):
-- redis.del(f"notifications:unread:{erased_user_id}")
```

Safety net: every `SET` of `notifications:unread:{user_id}` includes `EX 2592000` (30 days). `GET /notifications/unread-count` short-circuits to `{ "count": 0 }` and DELs the key when `users.status = 'deleted'`.

### 4.5 Redis Lua Scripts

**Decrement with floor at 0** (used on mark-read / dismiss):

```lua
-- KEYS[1] = "notifications:unread:{user_id}"; ARGV[1] = decrement (default 1)
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil then return 0 end
local new_val = current - tonumber(ARGV[1])
if new_val < 0 then new_val = 0 end
redis.call('SET', KEYS[1], new_val, 'EX', 2592000)
return new_val
```

**Admin email throttle** (shared per `notification_code`):

```lua
-- KEYS[1] = "throttle:admin_email:{notification_code}"; ARGV[1] = TTL seconds (900)
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]))
return 1
```

**`read-all` reconcile** (single PG transaction, then Redis SET):

```sql
BEGIN;
WITH updated AS (
  UPDATE notifications
  SET    read_at = now()
  WHERE  recipient_user_id = $1
    AND  read_at IS NULL
    AND  channel = 'in_app'
    AND  dismissed_at IS NULL
  RETURNING 1
)
SELECT COUNT(*) AS remaining_unread
FROM   notifications
WHERE  recipient_user_id = $1
  AND  read_at IS NULL
  AND  dismissed_at IS NULL
  AND  channel = 'in_app'
  AND  created_at > now() - INTERVAL '30 days';
COMMIT;
-- App: redis.set(f"notifications:unread:{user_id}", remaining_unread, ex=300)
```

Reconcile reads happen AFTER the UPDATE within the same TX; concurrent INSERTs either commit before (counted) or after (next request reconciles).

### 4.6 Event → Notification Catalog

Codes use `<intent>` form (e.g., `deal_disputed_as_provider`); event types are the producer's outbox `event_type`. Mandatory bypasses all preferences and rate caps.

| Outbox event | Notification code(s) | Recipients | In-app | Email | Push | Mandatory | Digest |
|---|---|---|---|---|---|---|---|
| `deal.created` | `deal_created_for_provider` | provider | ✓ | ✓ | ✓ | — | — |
| `deal.activated` | `deal_activated_*` | both | ✓ | ✓ | ✓ | — | — |
| `deal.rejected` | `deal_rejected_for_client` | client | ✓ | ✓ | ✓ | — | — |
| `deal.submitted` | `deal_submitted_for_client` | client | ✓ | ✓ | ✓ | — | — |
| `deal.approved` | `deal_approved_for_provider` | provider | ✓ | ✓ | ✓ | — | — |
| `deal.disputed` | `deal_disputed_as_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `deal.auto_completed` | `deal_auto_completed_*` | both | ✓ | ✓ | ✓ | — | — |
| `deal.cancel_requested` | `deal_cancel_requested_for_counterparty` | counterparty | ✓ | ✓ | ✓ | — | — |
| `deal.cancelled_by_client` | `deal_cancelled_by_client_for_provider` | provider | ✓ | ✓ | — | — | — |
| `deal.cancelled_mutual` | `deal_cancelled_mutual_*` | both | ✓ | ✓ | — | — | — |
| `deal.cancelled_escrow_timeout` | `deal_cancelled_escrow_timeout_*` | both | ✓ | ✓ | — | — | — |
| `deal.expired_pending` | `deal_expired_pending_for_client` | client | ✓ | ✓ | — | — | — |
| `deal.dispute_resolved` | (system-only since v1.3 — superseded by per-party `dispute.resolution_published_for_{client,provider}` rows from Module 14) | — | — | — | — | — | — |
| `deal.dispute_escalated` | `deal_dispute_escalated_admin` | admin queue | ✓ | ✓ | — | — | — |
| `deal.dispute_unresolved` | `deal_dispute_unresolved_*` | both | ✓ | ✓ | ✓ | ✓ | — |
| `kyc.submitted` | `kyc_submitted_admin` | admin queue | ✓ | — | — | — | daily |
| `kyc.approved` | `kyc_approved_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `kyc.rejected` | `kyc_rejected_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `kyc.expired` | `kyc_expired_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `kyc.rekyc_required` | `kyc_rekyc_required_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `kyc.suspended` | `kyc_suspended_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `kyc.document_scan_failed` | `kyc_document_scan_failed_for_provider` | provider | ✓ | ✓ | — | ✓ | — |
| `listing.submitted_for_review` | `listing_submitted_admin` | admin queue | ✓ | — | — | — | hourly |
| `listing.published` | `listing_published_for_provider` | provider | ✓ | ✓ | — | — | — |
| `listing.rejected` | `listing_rejected_for_provider` | provider | ✓ | ✓ | — | — | — |
| `listing.auto_paused` | `listing_auto_paused_for_provider` | provider | ✓ | ✓ | ✓ | — | — |
| `listing.force_archived` | `listing_force_archived_for_provider` | provider | ✓ | ✓ | — | — | — |
| `listing.draft_expired` | `listing_draft_expired_for_provider` | provider | ✓ | ✓ | — | — | — |
| `listing.category_archived` | `listing_category_archived_for_provider` | provider | ✓ | ✓ | — | — | — |
| `listing.reported` | `listing_reported_admin` | admin queue | ✓ | — | — | — | hourly |
| `listing.appeal_filed` | `listing_appeal_filed_admin` | admin queue | ✓ | — | — | — | hourly |
| `media.scan_threat` | `media_scan_threat_for_uploader` | uploader | ✓ | ✓ | ✓ | ✓ | — |
| `media.scan_error_permanent` | `media_scan_error_permanent_for_uploader` | uploader | ✓ | ✓ | — | — | — |
| `review.submitted` | `review_submitted_about_you` (content-free) | reviewee | ✓ | — | — | — | (suppressed until reveal) |
| `review.status_changed` (`to_status='published'` only) | `review_published_for_you` | reviewee | ✓ | ✓ | — | — | — |
| `review.replied` | `review_replied_for_reviewer` | reviewer | ✓ | ✓ | — | — | daily |
| `review.reported` | `review_reported_admin` | admin queue | ✓ | — | — | — | hourly |
| `category.proposed` | `category_proposed_admin` | admin queue | ✓ | — | — | — | daily |
| `category.approved` | `category_approved_for_proposer` | proposer | ✓ | ✓ | — | — | — |
| `category.rejected` | `category_rejected_for_proposer` | proposer | ✓ | ✓ | — | — | — |
| `category.auto_rejected` | `category_auto_rejected_for_proposer` | proposer | ✓ | ✓ | — | — | — |
| `message.created` | `new_message_for_recipient` | recipient | ✓ | — | ✓ | — | — |
| `conversation.blocked` | `conversation_blocked_confirmation` | blocker | ✓ | — | — | — | — |
| `message.auto_redacted` | `message_redacted_for_sender` | sender | ✓ | ✓ | — | ✓ | — |
| `payment.captured` | `payment_captured_for_client` | client | ✓ | ✓ | ✓ | — | — |
| `payment.failed` | `payment_failed_for_client` | client | ✓ | ✓ | ✓ | ✓ | — |
| `payment.hold_expiring` | `payment_hold_expiring_for_client` | client | ✓ | ✓ | ✓ | — | — |
| `payout.requested` | `payout_initiated_for_provider` | provider | ✓ | ✓ | — | — | — |
| `payout.completed` | `payout_completed_for_provider` | provider | ✓ | ✓ | ✓ | — | — |
| `payout.failed` | `payout_failed_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `refund.issued` | `refund_issued_for_client` | client | ✓ | ✓ | ✓ | — | — |
| `chargeback.received` | `chargeback_received_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `chargeback.lost` | `chargeback_lost_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `dispute.evidence_submitted` | `dispute_evidence_submitted_for_counterparty` | counterparty | ✓ | ✓ | ✓ | ✓ | — |
| `dispute.response_submitted` | `dispute_response_submitted_for_disputer` | client (original disputer) | ✓ | ✓ | ✓ | ✓ | — |
| `dispute.response_reminder` | `dispute_response_due_reminder` | provider | ✓ | ✓ | ✓ | ✓ | — |
| `dispute.resolution_published_for_client` | `dispute_resolution_published_for_client` | client | ✓ | ✓ | ✓ | ✓ | — |
| `dispute.resolution_published_for_provider` | `dispute_resolution_published_for_provider` | provider | ✓ | ✓ | ✓ | ✓ | — |

**Non-notifiable (system-only) events:** `user.soft_deleted`, `user.gdpr_erased_*` (triggers erasure, not a notification — Messaging's `user.gdpr_erased_messages` is in this set), `deal.escrow_*`, `deal.transition_rejected`, `listing.created`, `listing.edited`, `listing.bulk_*`, `listing.paused` (provider-self-paused), `media.scan_clean`, `media.deleted`, `kyc.document_ready`, `category.archived`, `category.admin_created`, `category.name_edited`, `conversation.created` (informational; surfaced to recipient via the first `message.created`), `message.contact_info_detected`, `message.attachment_threat`, `message.reported` (these route to the admin queue via `admin_notifications`, not user inbox), `payment.hold_expired` (system; triggers Deal `deal.cancelled_hold_expired` instead), `refund.failed` (system; admin queue only), `chargeback.won` / `chargeback.arbitration_won` / `chargeback.settled` (system; ledger-internal — v1.2), `wallet.balance_changed` (too noisy; opt-in low-balance derived signal deferred — v1.2), `deal.dispute_resolved` (superseded by per-party `dispute.resolution_published_for_{client,provider}` — v1.3 dedup; deal.dispute_resolved still emitted by Deal state machine for non-notification consumers).

**v1.1 — Messaging integration notes:**

- `message.created` (`aggregate_type='message'`) is dispatched per-recipient. Email is intentionally omitted at MVP — messaging is real-time-first; an email digest for unread messages is deferred to a future amendment.
- `conversation.blocked` (`aggregate_type='conversation'`) sends an in-app confirmation to the blocker only. The blocked user is not notified (deliberate; matches industry norm for safety).
- `message.auto_redacted` (`aggregate_type='message'`) is `mandatory=true` because it informs the sender of a moderation action; it bypasses preferences and quiet hours.
- Push coalescing for `message.created` uses `digest_key='msg_conv:{recipient_id}:{conversation_id}'` with a 5-minute window (in-app remains per-message).

**v1.2 — Payments integration notes:**

- Event names match Payments §4.7 outbox table verbatim. `payment.captured` (`aggregate_type='payment'`), `payment.failed` (mandatory), `payment.hold_expiring`, `payout.requested|completed|failed`, `refund.issued`, `chargeback.received|lost` (mandatory).
- `payment.hold_expiring` is paired with `deal.escrow_hold_warning` (declared on the deal aggregate by Deal v1.2; producer is Payments — see Payments REQ-021). Only the `payment.hold_expiring` row is catalog-registered; `deal.escrow_hold_warning` is intentionally NOT in this catalog to prevent duplicate delivery (the paired emission produces two outbox rows per warning, but only one notification fires).
- `chargeback.received` ALSO produces one `admin_notifications` row (code `chargeback_received_admin`) for Module 12 admin handling. That row is registered in the Payments / Chargebacks spec, NOT this catalog.
- `wallet.balance_changed` is intentionally NOT in this catalog (fires on every ledger write; far too noisy). A future low-balance threshold notification is deferred — it requires a producer-side filter inside Payments before emission, which is out of scope for v1.2.

**v1.3 — Disputes UI integration notes:**

- All `dispute.*` events ride **`aggregate_type='deal'`** per Module 14 REQ-012 (see `spec-design-disputes-ui-flow.md` §4.7). They are routed via the existing `'deal'` allowlist — no new aggregate_type is registered in v1.3.
- `dispute.evidence_submitted` — counterparty resolved from payload (submitter=client → notify provider, and vice-versa). Mandatory: legal-deadline-bearing event.
- `dispute.response_submitted` — notifies the original disputer (client) that the provider responded. Mandatory.
- `dispute.response_reminder` — emitted when 24 h remain in the 3-day provider response window (Module 14 REQ-011). Mandatory; quiet-hours bypass. Code name `dispute_response_due_reminder` matches Module 14 §4.8 catalog row verbatim.
- `dispute.resolution_published_for_client` / `dispute.resolution_published_for_provider` — TWO distinct outbox event types (per Module 14 REQ-012 / §4.8). Each fans out to ONE notification row (per-party). Mandatory.
- **Dedup with `deal.dispute_resolved`:** Admin `/resolve` (Deal §4.5) ALSO emits `deal.dispute_resolved` for state-machine integration. To prevent duplicate user-facing notifications, `deal.dispute_resolved` is moved to non-notifiable in v1.3 (see catalog row above and the non-notifiable list). The `dispute.resolution_published_for_{client,provider}` events are now the canonical user-notification source for resolutions.

### 4.7 REST API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/notifications` | access | Paginated in-app inbox |
| GET | `/api/v1/notifications/unread-count` | access | Cached unread count |
| POST | `/api/v1/notifications/{id}/read` | access | Mark single as read |
| POST | `/api/v1/notifications/read-all` | access | Mark all as read (CTE-based reconcile) |
| DELETE | `/api/v1/notifications/{id}` | access | Soft-dismiss (sets `dismissed_at`) |
| GET | `/api/v1/notifications/preferences` | access | Get all user preferences |
| PATCH | `/api/v1/notifications/preferences` | access | Bulk update; mandatory codes return `422 cannot_opt_out_mandatory` |
| POST | `/api/v1/device-tokens` | access | Register token |
| DELETE | `/api/v1/device-tokens/{token}` | access | Deregister token |
| POST | `/api/v1/notifications/device-tokens/heartbeat` | access | Update `last_heartbeat_at`; ownership-checked |
| GET | `/api/v1/notifications/unsubscribe?token=<jwt>` | signed JWT | One-click unsubscribe (RFC 2369 List-Unsubscribe target) |
| GET | `/api/v1/admin/notifications` | admin/mod | Shared admin queue (filter `?status=`) |
| POST | `/api/v1/admin/notifications/{id}/claim` | admin/mod | Atomic claim; returns 409 on race |
| POST | `/api/v1/admin/notifications/{id}/ack` | admin/mod | Acknowledge |
| POST | `/api/v1/admin/notifications/preview` | admin | Render template with synthetic payload |

**`POST /admin/notifications/{id}/claim` race response (409):**

```json
{
  "error": "already_claimed",
  "claimed_by": "11111111-1111-1111-1111-111111111111",
  "claimed_at": "2026-05-08T10:14:22Z"
}
```

UI MUST NOT auto-retry; it refreshes the queue listing.

**`POST /api/v1/notifications/device-tokens/heartbeat`:**

```http
POST /api/v1/notifications/device-tokens/heartbeat
Authorization: Bearer <access_jwt>
Content-Type: application/json

{ "device_token": "fcm-token-string" }
```

Handler:
```sql
UPDATE device_tokens
SET    last_heartbeat_at = now()
WHERE  token = $1
  AND  user_id = $jwt_sub
  AND  invalidated_at IS NULL;
-- 0 rows  → 204? NO. Return 404.
-- 1 row   → 204 No Content.
-- No JWT  → 401. Mismatched ownership → falls through to 404 (no token leak).
```

### 4.8 Notifications-Emitted Outbox Events

| event_type | aggregate_type | When | Payload |
|---|---|---|---|
| `notification.sent` | `notification` | delivery succeeds | `{notification_id, user_id, channel, notification_code}` |
| `notification.failed` | `notification` | retries exhausted | `{notification_id, user_id, channel, notification_code, error_detail}` |
| `notification.bounced` | `notification` | bounce/complaint webhook | `{notification_id, user_id, provider_msg_id, bounce_type}` |
| `preference.updated` | `user` | user PATCHes preferences | `{user_id, changes:[{code, channel, enabled}]}` |

## 5. Acceptance Criteria

- **AC-001** — Given a `deal.activated` event with both `client_id` and `provider_id`, When the worker processes it, Then exactly two `notifications` rows are inserted per channel (one per party), each with the same `source_event_id` but different `recipient_user_id`.
- **AC-002** — Given a duplicate scan of the same `outbox_events.id`, When the worker INSERTs, Then `ON CONFLICT (source_event_id, recipient_user_id, channel, notification_code) DO NOTHING` produces zero new rows.
- **AC-003** — Given a `review.status_changed` event with `payload->>'to_status' IN ('hidden','removed')`, When the worker handles it, Then NO `review_published_for_you` notification is created.
- **AC-004** — Given two admins online and one `deal.dispute_escalated` event, When both POST `/admin/notifications/{id}/claim`, Then exactly one receives `200`, the other receives `409 already_claimed` with `claimed_by` populated.
- **AC-005** — Given two notifications-worker pods running, When both attempt a scan tick, Then only one acquires the cursor lock and processes events; the other returns from `SELECT FOR UPDATE SKIP LOCKED` with 0 rows and idles.
- **AC-006** — Given a notification fails 5 delivery attempts, When the 5th attempt is recorded, Then `notifications.status='failed'` and a `notification.failed` outbox event is appended in the same transaction.
- **AC-007** — Given an APNs response of `BadDeviceToken` for a token, When the response is processed, Then `device_tokens.invalidated_at = now()` for that token within the same TX.
- **AC-008** — Given user A's JWT and user B's device token, When user A POSTs `/notifications/device-tokens/heartbeat` with B's token, Then the response is `404` and `last_heartbeat_at` is unchanged.
- **AC-009** — Given a `user.gdpr_erased_reviews` event, When the worker handles it within 60 s, Then all `notifications` rows for that user with `created_at > now() - 12 months` have `body = NULL`, `template_vars = '{}'::jsonb`, `pii_erased_at` set; all `device_tokens` for that user are deleted.
- **AC-010** — Given a Redis flush, When the next `GET /notifications/unread-count` fires, Then a DB reconcile runs and the response equals the SQL count of unread in-app rows in the last 30 days.
- **AC-011** — Given a mandatory notification code, When the user PATCHes `enabled=false`, Then the response is `422 cannot_opt_out_mandatory` and the row in `notification_preferences` is unchanged.
- **AC-012** — Given quiet hours `23:00–08:00 Europe/Kyiv` for a user and an `email`/`push` notification at 02:00 local, When the worker dispatches, Then delivery is deferred to 08:00 local (in-app row is written immediately).
- **AC-013** — Given two concurrent `read-all` requests for the same user, When both run, Then no row remains with `read_at IS NULL` and the Redis counter ends at the SQL count of rows created concurrently with the requests (eventual consistency within 5 minutes).
- **AC-014** — Given an admin email throttle key for `kyc_submitted_admin` exists, When a second `kyc.submitted` event fires within 15 minutes, Then no admin email is dispatched and the corresponding `admin_notifications` row is still created.
- **AC-015** — Given a `review.submitted` event followed by `review.status_changed(to_status='published')` for the same `review_id`, When both are processed, Then exactly one `review_published_for_you` notification exists, and exactly one `review_submitted_about_you` (content-free) row exists.

## 6. Test Automation Strategy

- **Test Levels:** Unit (event-routing logic, template rendering, retry-schedule math, Lua-script semantics via mocked Redis); Integration (PG + Redis end-to-end against ephemeral containers); End-to-End (worker pod scaling, multi-instance lock behavior, GDPR sweep).
- **Frameworks:** project-default backend test stack (parity with prior modules — pytest/Go test suite per service language).
- **Test Data:** seed fixtures for `notification_types` registry; synthetic `outbox_events` rows; deterministic-jitter mode for retry-schedule tests.
- **CI/CD:** all tests run on PR; integration tests against a CI-spun Postgres + Redis; Lua scripts loaded from repo via SHA-pinned `EVALSHA`.
- **Coverage:** ≥85% line coverage on the Notifications service.
- **Performance:** load test consuming 10k events/min sustained for 1 hour; assert p99 in-app insert latency < 250 ms; assert email queue does not exceed 5-minute backlog at SES sandbox throughput.
- **Concurrency tests:** two-worker pod test asserting at-most-one cursor advance per tick; CAS race tests for `read-all` and admin-claim using barrier-synchronized goroutines/threads.

## 7. Rationale & Context

The orchestration loop produced 17 R1 decisions; CRITIC R1 issued 11 risks (REJECT). R2 refinements addressed each, but introduced eight correction-class risks plus three carry-forwards (REJECT). R3 corrections converged the design:

- **Outbox-only ingestion** (CON-001) — The R2 `deal_events` polling fallback was rejected because dual ingestion produced two delivery semantics (at-most-once polling vs. at-least-once outbox), undefined restart recovery, and `source_event_id` namespace ambiguity. The correct fix is a Deal spec v1.1 amendment adding the missing notification-relevant events to the outbox registry. Module 9 ships behind that prerequisite.
- **Single-active worker** (REQ-004, AC-005) — `SELECT FOR UPDATE SKIP LOCKED` on the cursor row mirrors Deal spec §4.9's timer-worker pattern. Multiple pods are permitted (HA), only one processes per tick. Eliminates the duplicate-delivery class of race entirely.
- **Single-namespace `source_event_id`** (CON-006) — Both `notifications` and `admin_notifications` reference `outbox_events.id` (BIGINT) with `CHECK (source_event_id > 0)`. No FK because outbox is pruned at 7 days (Category Tree §4.3).
- **Admin shared queue with claim/ack** (REQ-010, AC-004) — Replaces per-admin fan-out (which was `O(N admins × M events)` at burst). Single row per `(source_event_id, notification_code)` in `admin_notifications`; admins claim atomically; race losers receive `409`. Email is best-effort and shared-throttled per code at 15 minutes; admins discover work via the inbox UI (GUD-002).
- **Heartbeat-based device GC** (REQ-008, SEC-001) — `last_seen_at` was static post-registration; an authenticated heartbeat refreshes `last_heartbeat_at`. Ownership match enforced server-side; mismatch returns `404` to avoid token-existence leakage.
- **CTE-based `read-all` reconcile** — Ensures the unread reconcile count is computed inside the same TX as the UPDATE under `READ COMMITTED`. Eliminates the lost-update window between snapshot read and DB write.
- **Lua-floor DECR + 30-day Redis TTL** — Counter cannot go negative. Stale keys self-expire within 30 days. PG is authoritative.
- **GDPR PG-authoritative, Redis best-effort** (REQ-012, CON-007, AC-009) — The 12-month sweep is housekeeping, not the GDPR mechanism. Erasure runs on the `user.gdpr_erased_*` event in a single PG transaction. Redis DEL is best-effort with 30-day TTL safety net and a `users.status='deleted'` short-circuit on read.
- **Mandatory notification class** (REQ-011) — Security and legal events (KYC payout-gate changes, dispute resolution, malware detection) bypass preferences, rate caps, quiet hours, and unsubscribe. Templates of mandatory emails declare so in their footers per CAN-SPAM/GDPR Article 21(2).
- **No template DB at MVP** (CON-002) — Versioned template tables introduce two-phase deploys for content edits. With single locale and no A/B testing requirement, code constants are sufficient. The cost of migrating to a DB table later is one migration.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** — APNs (Apple Push Notification service). HTTP/2 API. Required for iOS push.
- **EXT-002** — FCM (Firebase Cloud Messaging) v1 HTTP API. Required for Android push.
- **EXT-003** — Email ESP — primary provider Amazon SES; fallback SendGrid. Both behind `EmailProvider` interface.

### Third-Party Services
- **SVC-001** — ESP webhook (bounce/complaint feedback). 99.5% availability target. Authenticated with provider-specific signature verification.
- **SVC-002** — Push provider feedback channels — APNs `feedback` close events; FCM unregistered-token responses on send.

### Infrastructure Dependencies
- **INF-001** — PostgreSQL 15+ (shared cluster). `outbox_events`, `users`, `user_profiles`, `user_roles` tables required.
- **INF-002** — Redis 7+ (shared cluster). Used for unread-count counters, rate-limit windows, admin-email throttle. Persistence not required for correctness; PG is authoritative.
- **INF-003** — Worker runtime (containers, Kubernetes-class scheduler). MAY scale horizontally.

### Data Dependencies
- **DAT-001** — `outbox_events` (Category Tree §4.3) — primary input stream.
- **DAT-002** — `users.locale`, `user_profiles.timezone`, `user_profiles.notif_quiet_*` — read for rendering and quiet-hours gating.
- **DAT-003** — `user_roles` — admin recipient resolution (cached 5 min in Redis).

### Technology Platform Dependencies
- **PLT-001** — JWT signer (RS256) for unsubscribe tokens; same key infrastructure as Auth (spec-architecture-users-authentication).
- **PLT-002** — Mustache template engine (logic-less rendering).

### Compliance Dependencies
- **COM-001** — GDPR Article 17 (right to erasure) — implemented via REQ-012, AC-009.
- **COM-002** — CAN-SPAM Act / RFC 2369 — `List-Unsubscribe` header on every non-mandatory email; one-click unsubscribe endpoint.

## 9. Examples & Edge Cases

### 9.1 Inbox listing response

```json
GET /api/v1/notifications?limit=20

200 OK
{
  "items": [
    {
      "id": "9f1c…",
      "notification_code": "deal_submitted_for_client",
      "aggregate_type": "deal",
      "aggregate_id": "5b2e…",
      "subject": null,
      "body": "Провайдер надіслав роботу на перевірку за угодою «Ремонт Bosch».",
      "deep_link": "/deals/5b2e…",
      "read_at": null,
      "created_at": "2026-05-08T11:45:00Z"
    }
  ],
  "next_cursor": "2026-05-08T11:44:59Z",
  "unread_count": 3
}
```

### 9.2 Erased notification body render

```text
notifications.body IS NULL  →  client renders "Повідомлення видалено" (locale-aware).
```

### 9.3 Edge case — dual-role admin in own deal escalation

Admin A is the client of Deal D. Deal D is escalated. The worker emits BOTH:

- `admin_notifications` row (recipient = admin queue, code `deal_dispute_escalated_admin`).
- `notifications` row (recipient = Admin A as the client, code `deal_disputed_as_provider` is N/A; the relevant party-level code fires for the counterparty, not Admin A).

The dedup constraint `UNIQUE(source_event_id, recipient_user_id, channel, notification_code)` is keyed on `notification_code` so dual-role admins never silently lose a row.

### 9.4 Edge case — review takedown after publish

Sequence: `review.status_changed(from='pending', to='published')` → `review_published_for_you` fires. Later `review.status_changed(from='published', to='removed')` → handler returns `[]` (gate on `to_status='published'`). No takedown notification surfaces to the reviewee through this module.

### 9.5 Edge case — Redis flush during `read-all`

1. User has 7 unread.
2. Redis flushes; key absent.
3. User clicks `read-all`: reads snapshot (`None`); UPDATE marks 7 read; CTE reports 0 remaining; app SETs counter to 0 with EX 300.
4. New notification arrives; INCR creates the key at 1 with the script's TTL refresh.

No counter goes negative, no lost update.

## 10. Validation Criteria

A compliant implementation MUST:

1. Pass all AC-001 through AC-015 in CI.
2. Fail the build if Deal spec v1.1's outbox additions are absent at deploy time (deploy-time check on `outbox_events.event_type` enum or registry seed).
3. Reject any code path that mutates `outbox_events.status` from the Notifications service.
4. Reject any code path that fans out admin notifications per-admin (single-row `admin_notifications` is the only model).
5. Reject any code path that updates `notifications.body` outside (a) initial INSERT with rendered content and (b) GDPR erasure.
6. Reject any unauthenticated heartbeat request or any heartbeat where `device_tokens.user_id <> jwt.sub`.
7. Verify dedup constraint behavior with a concurrent-INSERT integration test.
8. Verify `SELECT FOR UPDATE SKIP LOCKED` single-active behavior with a 2-pod integration test.
9. Provide automated GDPR-erasure regression tests asserting that `body` is NULL and `device_tokens` are deleted within 60 s of the erasure event.

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `users`, `user_profiles` (locale, timezone, quiet-hours columns), `user_roles` (admin recipient resolution), GDPR cascade.
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — `outbox_events` DDL and 7-day retention.
- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — `deal.*` outbox events; v1.1 §4.8.2 adds the 12 notification-consumed deal events (CON-001 satisfied).
- [`spec/spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — `kyc.*` events; mandatory classification.
- [`spec/spec-architecture-listings.md`](./spec-architecture-listings.md) — `listing.*` events.
- [`spec/spec-architecture-media-pipeline.md`](./spec-architecture-media-pipeline.md) — `media.scan_threat`, `media.scan_error_permanent`, `kyc.document_scan_failed`.
- [`spec/spec-architecture-reviews.md`](./spec-architecture-reviews.md) — `review.*` events; GUD-005 reveal coalescing; `user.gdpr_erased_reviews`.
- [`spec/spec-architecture-feed.md`](./spec-architecture-feed.md) — emits no outbox events; not a producer.
- [`spec/spec-architecture-messaging.md`](./spec-architecture-messaging.md) — producer of `message.*` and `conversation.*` events consumed via the v1.1 allowlist extension and §4.6 catalog rows (`new_message_for_recipient`, `conversation_blocked_confirmation`, `message_redacted_for_sender`).
- RFC 2369 — `List-Unsubscribe` header.
- RFC 8058 — One-click unsubscribe (GET-based).
