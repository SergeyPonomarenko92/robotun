---
title: Messaging — Two-Sided Client↔Provider Direct Messaging
version: 1.1
date_created: 2026-05-08
last_updated: 2026-05-09
owner: Platform / Messaging
tags: [architecture, messaging, sse, realtime, attachments, gdpr, anti-abuse, disputes]
---

# Introduction

Module 10 — Messaging provides direct, 1:1 conversations between Client and Provider, anchored to a specific listing (pre-deal inquiry) or a specific deal. It owns conversation lifecycle, message delivery, attachments (via the Media Pipeline), realtime fan-out via Server-Sent Events, anti-abuse guards (rate limits, contact-info detection, profanity, blocks, reports), GDPR erasure of message bodies, and emission of outbox events to the Notifications module.

## 1. Purpose & Scope

This specification defines:

- The conversation model: scope (`pre_deal` | `deal`), parties, status lifecycle, locking on deal terminal states.
- Initiation rules: only Clients may create `pre_deal` conversations against an active listing; either party may create a `deal`-scoped conversation against a non-terminal deal.
- Data model for conversations, messages, attachments (delegating to `media_objects`), blocks, reports, SSE cursors, messaging-owned user state.
- Send pipeline: same-TX `users.status` re-read (MSG-SEC-001), block check via single CTE, mandatory advisory lock to close block-vs-send TOCTOU, idempotent insert.
- Realtime: SSE per conversation; Redis pub/sub fan-out; gap-fill on reconnect bounded to 7 days.
- Lazy unread counter (no denormalized columns), Redis cache with post-commit invalidation.
- Anti-abuse: tightened contact-info regexes (E.164 + UA local 0XXXXXXXXX + RFC 5322 email + Telegram/Viber/WhatsApp/Skype handles), `≥5 flags / 7 days` auto-block threshold, first auto-block requires admin confirmation, profanity flag-and-log.
- GDPR erasure: `body=NULL`, `body_scrub_reason='gdpr'`, `gdpr_erased_at` timestamp set on PII-erasure events. API projection rule: never expose `gdpr_erased_at` or `body_scrub_reason` in user-facing responses.
- API surface: REST + SSE.
- Retention sweeps: reports (12mo), orphan reports (30d), SSE cursors (90d).
- Outbox events emitted: `message.created`, `conversation.created`, `conversation.blocked`, `message.reported`, `message.contact_info_detected`, `message.attachment_threat`, `message.auto_redacted`, `user.gdpr_erased_messages`.

**Hard prerequisites — Module 10 cannot ship before BOTH amendments land:**

1. **Media Pipeline v1.1** — adds `purpose='message_attachment'`, `message_id` FK, updated `chk_exactly_one_owner`, advisory-lock cap pattern.
2. **Notifications v1.1** — extends worker scan allowlist `aggregate_type IN ('deal','review','user','message','conversation')` and adds three §4.6 catalog rows (`new_message_for_recipient`, `conversation_blocked_confirmation`, `message_redacted_for_sender`).

**Audience:** backend, mobile, SRE, security/legal reviewers.

**Assumptions:** PostgreSQL 15+, Redis 7+, REST/JSON over HTTPS, JWT (RS256, 15-min access), all timestamps `TIMESTAMPTZ` UTC. Outbox table from Category Tree §4.3.

**Out of scope:** group conversations, presence/online status, voice/video, message forwarding, markdown rendering, push delivery receipts, provider-initiated cold contact, in-chat escrow, KYC gating at conversation init, edit history table, mTLS for `/internal` (service-account JWT + network isolation only), translation, SMS fallback, cross-conversation search, Ukrainian morphological FTS at MVP.

## 2. Definitions

- **Conversation** — durable 1:1 channel between exactly one Client and one Provider, anchored to a listing or a deal.
- **Pre-deal scope** — conversation anchored to a `listings` row; only Client may initiate.
- **Deal scope** — conversation anchored to a `deals` row; either party may initiate.
- **Locked conversation** — `status='locked'`; read-only after deal reaches a terminal state (`completed`, `cancelled`). `disputed` is NOT a locking trigger; the conversation remains open for both parties with `admin_visible=TRUE` applied to all messages (Module 14).
- **SSE** — Server-Sent Events; unidirectional server→client over HTTP/2.
- **Block** — user-level mute; `(blocker_id, blocked_id)` row prevents the blocked user from sending into any conversation with the blocker.
- **TOCTOU** — Time-of-check / time-of-use race.
- **GDPR erasure** — explicit user-requested PII deletion path; distinct from FK `ON DELETE SET NULL` on hard purge.

## 3. Requirements, Constraints & Guidelines

### Requirements

- **REQ-001** — `pre_deal` conversations MUST be Client-initiated only and require a listing in `status='active'` at creation time.
- **REQ-002** — `deal`-scoped conversations MUST verify deal exists, caller is a party, and `deals.status NOT IN ('completed','cancelled')` synchronously at creation. `disputed` deals allow new conversation creation (Module 14: conversation stays open during dispute).
- **REQ-003** — Conversation creation MUST be idempotent per `(scope, listing_id|deal_id, client_id, provider_id)` via UNIQUE constraints.
- **REQ-004** — Message body limit: 4000 characters, enforced application-side; over-limit returns `400 body_too_long`.
- **REQ-005** — Edit/delete window for sender: 10 minutes from `created_at`. After 10 min: `409 edit_window_expired`.
- **REQ-006** — Cursor pagination on `GET /conversations/{id}/messages` uses `(created_at, id)`-tuple opaque base64 cursors; default page size 50, max 100.
- **REQ-007** — Conversation lock on deal terminal state via outbox consumer calling `POST /internal/conversations/lock-by-deal`. Terminal states that trigger locking: `completed`, `cancelled`. `disputed` does NOT trigger locking (Module 14). Lock is irreversible by users; admins may unlock for review.
- **REQ-021** — When `deals.status = 'disputed'`, all messages sent into the deal's conversation MUST be inserted with `admin_visible = TRUE`. All prior messages in that conversation MUST be backfilled to `admin_visible = TRUE` by the outbox consumer handling `deal.status_changed{new_status: 'disputed'}`. On exit from `disputed`, new messages revert to `admin_visible = FALSE` (default); existing flipped messages retain `admin_visible = TRUE` permanently as an audit trail. Admin/moderator roles MAY read all `admin_visible=TRUE` messages via `GET /api/v1/admin/deals/{deal_id}/messages`.
- **REQ-008** — Realtime delivery via SSE per conversation. Redis pub/sub fan-out at key `conv:{conversation_id}`.
- **REQ-009** — SSE reconnection MUST gap-fill via `messages` table within a 7-day window; older history requires REST pagination.
- **REQ-010** — Unread counts computed lazily (no denormalized columns). Cached in Redis with TTL 300 s. Cache invalidation occurs only AFTER PostgreSQL commit.
- **REQ-011** — Contact-info detection runs server-side on every message body. ≥5 detected hits in 7 days triggers escalation; first auto-block per user requires admin confirmation via Module 9 admin queue.
- **REQ-012** — Profanity detection flag-and-log; ≥3 profanity flags in 7 days auto-blocks send for 1 hour.
- **REQ-013** — Per-message attachment cap: 5; per-attachment 10 MB; per-message total 25 MB. Enforced via `pg_advisory_xact_lock(hashtextextended(message_id::text, 0))` (1-arg BIGINT, no INT4 collision).
- **REQ-014** — Allowed attachment MIME types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`. Set in Media Pipeline v1.1 for `purpose='message_attachment'`.
- **REQ-015** — Attachment scan-pending visibility: sender sees pending; recipient sees attachment only after `media_objects.status='ready'`. Threat: hidden from both, `message.attachment_threat` outbox event emitted.
- **REQ-016** — `message_reports` retention sweep daily: delete rows with `status IN ('actioned','dismissed') AND created_at < now() - 12 months`; delete orphan reports older than 30 days when parent message is hard-deleted.
- **REQ-017** — `sse_cursors` retention sweep weekly: delete rows with `last_seen_at < now() - 90 days`.
- **REQ-018** — GDPR erasure on `user.gdpr_erased_*`: set `body=NULL`, `body_scrubbed=TRUE`, `body_scrub_reason='gdpr'`, `gdpr_erased_at=now()` for sender's messages within 12-month window. Emit `user.gdpr_erased_messages`.
- **REQ-019** — User-facing API responses MUST treat `gdpr_erased_at IS NOT NULL` identically to `deleted_at IS NOT NULL`: render `[повідомлення видалено]`, omit `gdpr_erased_at` and `body_scrub_reason` from response payloads. Admin/internal endpoints (`/admin/`, `/internal/`) retain full columns including `gdpr_erased_at` and `body_scrub_reason` for compliance audit purposes. For `admin_visible=TRUE` messages where body has been GDPR-erased, the admin response renders `body` as `null` and includes the erasure metadata columns.
- **REQ-020** — Messaging emits outbox events with `aggregate_type IN ('message','conversation','user')`. Notifications v1.1 worker MUST consume.

### Security

- **MSG-SEC-001** — Message send handler MUST re-read `users.status` from primary database within the same transaction as the `messages` INSERT and reject if `status <> 'active'`. JWT claims MUST NOT be the sole authority due to 15-min TTL accepting revocation lag (mirrors Auth SEC-006).
- **MSG-SEC-002** — `POST /conversations/{id}/messages` MUST acquire `pg_advisory_xact_lock(hashtextextended('block_pair:'||LEAST(sender,recipient)||':'||GREATEST(sender,recipient), 0))` BEFORE the block-check CTE. Same lock acquired by `POST /conversations/{id}/block` to fully serialize block-vs-send.
- **MSG-SEC-003** — Listing status check at conversation create returns uniform `404` for non-existent OR non-active listings (no enumeration sidechannel; mirrors Listings SEC-003).
- **MSG-SEC-004** — Internal endpoint `POST /internal/conversations/lock-by-deal` authenticates via service-account JWT (audience `internal.messaging`); mTLS deferred per CON-005.
- **MSG-SEC-005** — Attachment ownership transitively derived through `messages.sender_id`. `media_objects` rows for `purpose='message_attachment'` MUST have `owner_user_id IS NULL`.
- **MSG-SEC-006** — `gdpr_erased_at` and `body_scrub_reason` MUST NEVER appear in user-facing API responses. Admin/internal endpoints are exempt from this restriction (internal compliance surfaces).
- **MSG-SEC-007** — `GET /api/v1/admin/deals/{deal_id}/messages` MUST verify the caller JWT contains role `admin` or `moderator` (Module 12 RBAC matrix) before returning any rows. A missing or insufficient role MUST return `403` with no row leakage.

### Constraints

- **CON-001** — Module 10 cannot ship before Media Pipeline v1.1 amendment is finalized and deployed.
- **CON-002** — Module 10 cannot ship before Notifications v1.1 amendment is finalized and deployed.
- **CON-003** — `messages` table is unpartitioned at MVP. Revisit at ~50 M rows.
- **CON-004** — At MVP, message search uses `'simple'` FTS configuration (no Ukrainian morphology). Best-effort capability; documented limitation.
- **CON-005** — `mTLS` for service-to-service traffic on `/internal` endpoints is deferred. Service-account JWT + network ACLs are the v1 control.
- **CON-006** — `messaging_user_state.contact_block_confirmed` is OWNED by Messaging. Cross-module writes to Auth-owned `users` table are forbidden.
- **CON-007** — Redis is best-effort; PostgreSQL is authoritative for all messaging state. Cache invalidation occurs post-commit only.
- **CON-008** — Group conversations are explicitly out of scope. The two-party model is enforced by `client_id <> provider_id` and the unique constraints.

### Guidelines

- **GUD-001** — Prefer SSE over WebSockets for realtime. Send paths use REST POST.
- **GUD-002** — Typing indicators are ephemeral, fire-and-forget, never persisted.
- **GUD-003** — When the Ukrainian text-search dictionary is present at deploy time, an additional GIN index using `'ukrainian'` is created opportunistically; the application query continues to use `'simple'` for portability.
- **GUD-004** — Messaging is the primary interaction surface; Notifications is the secondary alert channel. Notification email is omitted for `message.created` at MVP (real-time only).
- **GUD-005** — Block-vs-send TOCTOU is closed by mandatory advisory lock; no fallback path is permitted.

### Patterns

- **PAT-001** — Idempotent conversation creation via UNIQUE `(listing_id, client_id, provider_id)` and UNIQUE `(deal_id)` plus `INSERT ... ON CONFLICT DO NOTHING RETURNING id` then `SELECT` fallback.
- **PAT-002** — Single-CTE write for send: `WITH sender_check AS (... FOR SHARE), block_check AS (... FOR SHARE) INSERT ... WHERE sender active AND NOT EXISTS block_check`.
- **PAT-003** — Lazy aggregate via partial index: `idx_msg_unread (conversation_id, sender_id, read_at) WHERE read_at IS NULL AND deleted_at IS NULL`.
- **PAT-004** — 1-arg BIGINT advisory lock via `hashtextextended($key::text, 0)` to avoid INT4 32-bit collisions.

## 4. Interfaces & Data Contracts

### 4.1 Schema (PostgreSQL 15+)

```sql
-- 4.1.1 Enums
CREATE TYPE conversation_scope  AS ENUM ('pre_deal','deal');
CREATE TYPE conversation_status AS ENUM ('open','archived','locked');
CREATE TYPE message_status      AS ENUM ('sent','delivered','read','redacted','deleted');

-- 4.1.2 conversations
CREATE TABLE conversations (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           conversation_scope  NOT NULL,
  listing_id      UUID                REFERENCES listings(id) ON DELETE SET NULL,
  deal_id         UUID                REFERENCES deals(id)    ON DELETE RESTRICT,
  client_id       UUID                NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id     UUID                NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status          conversation_status NOT NULL DEFAULT 'open',
  last_message_id UUID,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
  CONSTRAINT chk_conv_scope_listing CHECK (scope <> 'pre_deal' OR listing_id IS NOT NULL),
  CONSTRAINT chk_conv_scope_deal    CHECK (scope <> 'deal'     OR deal_id    IS NOT NULL),
  CONSTRAINT chk_conv_parties       CHECK (client_id <> provider_id),
  CONSTRAINT uq_conv_listing UNIQUE (listing_id, client_id, provider_id),
  CONSTRAINT uq_conv_deal    UNIQUE (deal_id)
);
CREATE INDEX idx_conv_client   ON conversations (client_id,   last_message_at DESC NULLS LAST);
CREATE INDEX idx_conv_provider ON conversations (provider_id, last_message_at DESC NULLS LAST);
CREATE INDEX idx_conv_deal     ON conversations (deal_id)    WHERE deal_id    IS NOT NULL;
CREATE INDEX idx_conv_listing  ON conversations (listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX idx_conv_open     ON conversations (status, last_message_at DESC NULLS LAST) WHERE status = 'open';

-- 4.1.3 messages
CREATE TABLE messages (
  id                     UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id        UUID            NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  sender_id              UUID            REFERENCES users(id) ON DELETE SET NULL,
  body                   TEXT,
  body_scrubbed          BOOLEAN         NOT NULL DEFAULT FALSE,
  body_scrub_reason      TEXT            CHECK (body_scrub_reason IN ('gdpr','admin_redaction','sender_delete')),
  gdpr_erased_at         TIMESTAMPTZ,
  status                 message_status  NOT NULL DEFAULT 'sent',
  edited_at              TIMESTAMPTZ,
  deleted_at             TIMESTAMPTZ,
  read_at                TIMESTAMPTZ,
  contact_info_detected  BOOLEAN         NOT NULL DEFAULT FALSE,
  moderation_flagged     BOOLEAN         NOT NULL DEFAULT FALSE,
  moderation_actioned_at TIMESTAMPTZ,
  admin_visible          BOOLEAN         NOT NULL DEFAULT FALSE,  -- v1.1: TRUE when deal is disputed
  created_at             TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT chk_msg_body_or_attachment CHECK (
    body IS NOT NULL OR deleted_at IS NOT NULL OR body_scrubbed = TRUE
  )
);
CREATE INDEX idx_msg_conv_cursor ON messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX idx_msg_unread       ON messages (conversation_id, sender_id, read_at)
  WHERE read_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_msg_sender       ON messages (sender_id, created_at DESC) WHERE sender_id IS NOT NULL;
CREATE INDEX idx_msg_flagged      ON messages (moderation_flagged, created_at DESC) WHERE moderation_flagged;
CREATE INDEX idx_msg_deleted      ON messages (conversation_id, deleted_at) WHERE deleted_at IS NOT NULL;
-- v1.1: partial index for admin dispute review; small because disputed deals are a minority
CREATE INDEX idx_messages_admin_visible
  ON messages (conversation_id, created_at)
  WHERE admin_visible = TRUE;

ALTER TABLE conversations ADD CONSTRAINT fk_conv_last_message
  FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- 4.1.4 FTS generated column (always 'simple'; opportunistic UK index)
ALTER TABLE messages
  ADD COLUMN body_tsv TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;
CREATE INDEX idx_msg_body_fts ON messages USING GIN (body_tsv)
  WHERE deleted_at IS NULL AND body_scrubbed = FALSE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'ukrainian') THEN
    EXECUTE 'CREATE INDEX idx_msg_body_fts_uk ON messages USING GIN (to_tsvector(''ukrainian'', coalesce(body, '''')))
             WHERE deleted_at IS NULL AND body_scrubbed = FALSE';
  END IF;
END$$;

-- 4.1.5 message_attachments (no scan_status; reads media_objects.status)
CREATE TABLE message_attachments (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID         NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_object_id UUID         NOT NULL,            -- no FK; cross-module reference
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_msg_att_message ON message_attachments (message_id);
CREATE INDEX idx_msg_att_media   ON message_attachments (media_object_id);

-- 4.1.6 conversation_blocks
CREATE TABLE conversation_blocks (
  blocker_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT chk_block_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX idx_block_blocked ON conversation_blocks (blocked_id);

-- 4.1.7 message_reports
CREATE TABLE message_reports (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID         NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT         NOT NULL CHECK (reason IN ('spam','harassment','contact_info','inappropriate','other')),
  note         TEXT         CHECK (char_length(note) <= 500),
  status       TEXT         NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','actioned','dismissed')),
  reviewed_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX idx_report_pending ON message_reports (status, created_at) WHERE status = 'pending';

-- 4.1.8 sse_cursors (per user per conversation; 90-day retention)
CREATE TABLE sse_cursors (
  user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  UUID         NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_message_id  UUID,
  last_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);
CREATE INDEX idx_sse_cursors_last_seen ON sse_cursors (last_seen_at);

-- 4.1.9 messaging_user_state (Messaging-owned; never written from Auth)
CREATE TABLE messaging_user_state (
  user_id                  UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  contact_block_confirmed  BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 4.1.10 contact-info allowlist (platform handles to suppress false positives)
CREATE TABLE contact_info_allowlist (
  pattern_value  TEXT         PRIMARY KEY,    -- normalized lowercase, e.g. '@robotun'
  pattern_kind   TEXT         NOT NULL CHECK (pattern_kind IN ('telegram','email','phone','other')),
  note           TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

### 4.2 Send Pipeline (single-TX, mandatory advisory lock)

```sql
BEGIN;

-- Block-vs-send race closure (MSG-SEC-002, GUD-005)
SELECT pg_advisory_xact_lock(
  hashtextextended('block_pair:' || LEAST($sender::text, $recipient::text)
                                 || ':' || GREATEST($sender::text, $recipient::text), 0)
);

-- Single-statement insert with sender-status, block, and dispute-visibility guards
-- v1.1 DELTA: deal_status CTE reads deals.status FOR SHARE to set admin_visible atomically
WITH sender_check AS (
  SELECT status FROM users WHERE id = $sender FOR SHARE
),
block_check AS (
  SELECT 1 FROM conversation_blocks
  WHERE (blocker_id = $recipient AND blocked_id = $sender)
     OR (blocker_id = $sender    AND blocked_id = $recipient)
  FOR SHARE
),
-- v1.1: LEFT JOIN so non-deal conversations (deal_id IS NULL) yield deal_status = NULL
deal_status AS (
  SELECT d.status AS deal_status
  FROM conversations c
  LEFT JOIN deals d ON d.id = c.deal_id
  WHERE c.id = $conversation_id
  FOR SHARE
)
INSERT INTO messages (conversation_id, sender_id, body, admin_visible, created_at)
SELECT
  $conversation_id,
  $sender,
  $body,
  -- admin_visible TRUE iff deal-scoped conversation currently in disputed state
  COALESCE((SELECT deal_status = 'disputed' FROM deal_status), FALSE),
  now()
WHERE (SELECT status FROM sender_check) = 'active'
  AND NOT EXISTS (SELECT 1 FROM block_check)
RETURNING id, created_at, admin_visible;

COMMIT;
-- 0 rows returned → application maps to 403 account_suspended OR 403 blocked
-- App-level post-commit: redis.del("msg:unread:<recipient>:<conversation>"),
--                       redis.del("msg:unread_total:<recipient>"),
--                       PUBLISH conv:<conversation_id> {type: 'message.received', ...}
```

#### 4.2.1 Backfill on entry to `disputed` (outbox consumer)

When a deal transitions INTO `disputed`, the outbox consumer handling `deal.status_changed` performs a single bulk UPDATE to flip all prior messages. This is NOT a trigger — see §7 rationale.

```python
# Outbox consumer — handles event_type = 'deal.status_changed'

def handle_deal_status_changed(event: OutboxEvent) -> None:
    deal_id = event.payload["deal_id"]
    new_status = event.payload["new_status"]
    if new_status != "disputed":
        return  # only disputed transition triggers backfill

    with db.transaction():
        # Single UPDATE — idempotent (WHERE admin_visible = FALSE)
        db.execute("""
            UPDATE messages m
            SET admin_visible = TRUE
            WHERE m.conversation_id = (
                SELECT id FROM conversations WHERE deal_id = :deal_id
            )
              AND m.admin_visible = FALSE
        """, {"deal_id": deal_id})

        db.execute("""
            INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
            VALUES ('deal', :deal_id, 'deal.messages_made_admin_visible',
                    jsonb_build_object('deal_id', :deal_id))
        """, {"deal_id": deal_id})
```

#### 4.2.2 Rule on exit from `disputed`

When a dispute resolves (`dispute_resolved` / deal transitions to `completed` or a resolved terminal state):

- Messages already flipped to `admin_visible = TRUE` REMAIN `TRUE` permanently. They form the audit trail for adjudication.
- New messages inserted after resolution have `admin_visible = FALSE` (the DEFAULT; the `deal_status` CTE returns a non-`disputed` status, so `COALESCE(..., FALSE)` yields FALSE).
- No reverse UPDATE is performed. The flag is append-only in the TRUE direction.

### 4.3 Lazy Unread Counter

```sql
-- Per-conversation unread for caller (cached at msg:unread:{user}:{conversation}, TTL 300s)
SELECT COUNT(*) AS unread
FROM messages
WHERE conversation_id = $conversation_id
  AND sender_id <> $caller_user_id
  AND read_at IS NULL
  AND deleted_at IS NULL;

-- Total unread across all conversations (cached at msg:unread_total:{user}, TTL 300s)
-- ONE query — not N
SELECT COUNT(*) AS unread_total
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE (c.client_id = $user_id OR c.provider_id = $user_id)
  AND m.sender_id <> $user_id
  AND m.read_at IS NULL
  AND m.deleted_at IS NULL;
```

Redis invalidation timing: post-commit hook only. On TX failure, no DEL is issued and the cache expires naturally at 300 s TTL. Read queries run at READ COMMITTED — stale unread counts within the TTL window are accepted as documented eventual consistency.

### 4.4 Attachment Cap Enforcement

```sql
BEGIN;
-- 1-arg BIGINT advisory lock; hashtextextended avoids INT4 collision (PAT-004)
SELECT pg_advisory_xact_lock(hashtextextended($message_id::text, 0));

SELECT COUNT(*) INTO v
FROM media_objects
WHERE message_id = $message_id AND status <> 'deleted';

IF v >= 5 THEN
  RAISE EXCEPTION 'message_attachment_limit_exceeded' USING ERRCODE = 'P0001';
END IF;
-- Initiate Media Pipeline upload as normal (purpose='message_attachment', owner_user_id=NULL)
COMMIT;
```

### 4.5 GDPR Erasure (handler for `user.gdpr_erased_*`)

```sql
BEGIN;
-- Scrub bodies; preserve row for conversation integrity
UPDATE messages
SET body              = NULL,
    body_scrubbed     = TRUE,
    body_scrub_reason = 'gdpr',
    gdpr_erased_at    = now()
WHERE sender_id = $erased_user_id
  AND created_at > now() - INTERVAL '12 months';

-- Identity unlink (independent of FK ON DELETE SET NULL on hard purge)
UPDATE messages
SET sender_id = NULL
WHERE sender_id = $erased_user_id;

-- Outbox audit trail
INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
VALUES (
  'user', $erased_user_id, 'user.gdpr_erased_messages',
  jsonb_build_object('erased_user_id', $erased_user_id)
);
COMMIT;
```

API projection rule (REQ-019, MSG-SEC-006): user-facing endpoints returning message rows MUST treat `gdpr_erased_at IS NOT NULL` identically to `deleted_at IS NOT NULL`, render `[повідомлення видалено]`, and OMIT both `gdpr_erased_at` and `body_scrub_reason` from the response body.

**v1.1 — GDPR + admin_visible rule:** The GDPR erasure handler above runs on ALL messages for the erased user regardless of `admin_visible`. The `admin_visible` flag is NOT cleared by erasure — it remains `TRUE` on dispute-period messages to preserve the structural audit log. The body content (PII) is NULLed; the flag (non-PII structural metadata) is retained. Admin endpoints render `body` as `null` for erased messages and MAY include `gdpr_erased_at` and `body_scrub_reason` in the admin response (these are internal compliance surfaces, not user-facing, so MSG-SEC-006 does not apply).

**MSG-SEC-008 — admin access audit log (v1.1, GDPR Art. 5(2) accountability):** Every successful invocation of `GET /api/v1/admin/deals/{deal_id}/messages` MUST INSERT a row into `admin_actions` (Module 12 schema) within the same DB transaction as the SELECT, with:
```
actor_id     = caller's admin/moderator user_id
action       = 'view_dispute_messages'
target_type  = 'deal'
target_id    = deal_id
metadata     = {message_count: N, cursor_after: <cursor or NULL>}
```
A 403 RBAC rejection (MSG-SEC-007) MUST NOT write an `admin_actions` row (write only on authorised access). Retention follows the standard `admin_actions` retention schedule owned by Module 12. This satisfies the access-log requirement for residual structural metadata of GDPR-erased users surfaced via the admin endpoint.

### 4.6 Contact-Info Detection — Regex Set

```
PHONE_E164    : (?:^|\s)(?:\+|00)[1-9]\d{6,14}(?:\s|$)
PHONE_UA_LOCAL: (?:^|\s)0\d{9}(?:\s|$)
EMAIL_RFC5322 : (?:^|\s)[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,}(?:\s|$)
TELEGRAM      : (?:^|\s)@[a-z0-9_]{5,32}(?:\s|$)        — post-filter via contact_info_allowlist
VIBER         : viber\.me\/[a-zA-Z0-9_+]+
WHATSAPP      : wa\.me\/[0-9+]+
SKYPE         : skype:[a-zA-Z0-9._\-]+
```

Threshold: `≥5 detections in 7 days` for the same `sender_id` → escalation. **First** auto-block per user requires admin confirmation via Module 9 `admin_notifications` queue. Until `messaging_user_state.contact_block_confirmed = TRUE`, the user is flagged but not blocked. After admin acknowledges, subsequent detections at the threshold auto-block for 1 hour without re-confirmation.

### 4.7 REST + SSE API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/conversations` | access | List user's conversations (cursor-paginated, sorted `last_message_at DESC NULLS LAST`) |
| POST | `/api/v1/conversations` | access | Create or fetch idempotent conversation |
| GET | `/api/v1/conversations/{id}` | access | Get conversation detail |
| GET | `/api/v1/conversations/{id}/messages` | access | List messages (cursor pagination; optional `?q=` FTS) |
| POST | `/api/v1/conversations/{id}/messages` | access | Send message |
| PATCH | `/api/v1/conversations/{id}/messages/{msg_id}` | access | Edit (sender, ≤10 min) |
| DELETE | `/api/v1/conversations/{id}/messages/{msg_id}` | access | Soft-delete (sender, ≤10 min) |
| POST | `/api/v1/conversations/{id}/messages/{msg_id}/read` | access | Mark single as read |
| POST | `/api/v1/conversations/{id}/read-all` | access | Mark conversation as read |
| POST | `/api/v1/conversations/{id}/archive` | access | Archive conversation |
| POST | `/api/v1/conversations/{id}/unarchive` | access | Unarchive |
| POST | `/api/v1/conversations/{id}/messages/{msg_id}/report` | access | Report a message |
| POST | `/api/v1/conversations/{id}/block` | access | Block counterparty (acquires same advisory lock as send) |
| DELETE | `/api/v1/conversations/{id}/block` | access | Unblock |
| POST | `/api/v1/conversations/{id}/typing` | access | Ephemeral typing indicator (Redis-only) |
| GET | `/api/v1/conversations/{id}/events` | access | SSE stream |
| GET | `/api/v1/admin/conversations` | admin/mod | Admin listing/filter |
| GET | `/api/v1/admin/conversations/{id}/messages` | admin/mod | Admin full view |
| GET | `/api/v1/admin/deals/{deal_id}/messages` | admin/mod | v1.1: List `admin_visible=TRUE` messages for a disputed deal; cursor-paginated |
| POST | `/api/v1/admin/messages/{msg_id}/redact` | admin/mod | Force-redact (sets `body_scrub_reason='admin_redaction'`) |
| GET | `/api/v1/admin/message-reports` | admin/mod | Pending report queue |
| POST | `/api/v1/admin/message-reports/{id}/action` | admin/mod | Action or dismiss |
| POST | `/api/v1/internal/conversations/lock-by-deal` | service-account JWT | Deal outbox consumer locks conversation on terminal state (`completed`, `cancelled` only) |

**`POST /conversations` (idempotent)**

```json
// pre_deal: requires listing_id; only Client may call
{ "scope": "pre_deal", "listing_id": "uuid", "provider_id": "uuid" }

// deal: either party
{ "scope": "deal", "deal_id": "uuid" }

// 201 Created (new) or 200 OK (existing)
// 404 not_found              — listing not found OR not active (uniform)
// 409 deal_in_terminal_state — deal is completed/cancelled/disputed
// 403 blocked                — counterparty has blocked the caller
```

**`POST /conversations/{id}/messages`**

```json
// Request
{ "body": "...", "media_object_ids": ["uuid"] }

// 201 Created → message body
// 400 body_too_long                   — body > 4000 chars
// 400 body_or_attachment_required
// 403 account_suspended               — MSG-SEC-001
// 403 blocked                         — MSG-SEC-002
// 403 conversation_locked             — status='locked'
// 409 attachment_limit_exceeded       — > 5 attachments per message (REQ-013)
// 422 attachment_not_owned
// 422 attachment_wrong_purpose
// 429 rate_limit_exceeded
```

**`GET /admin/deals/{deal_id}/messages` (v1.1)**

RBAC: roles `admin`, `moderator` (Module 12 RBAC matrix). Returns only messages where `admin_visible = TRUE`. Cursor pagination identical to user-facing message list: `(created_at, id)` tuple, base64-encoded, default page 50, max 100.

```json
// GET /api/v1/admin/deals/{deal_id}/messages?cursor=...&limit=50

// 200 OK
{
  "deal_id": "uuid",
  "conversation_id": "uuid",
  "messages": [
    {
      "id": "uuid",
      "sender_id": "uuid",          // null if GDPR-unlinked
      "body": "...",                // null if GDPR-erased; render "[повідомлення видалено]" in UI
      "body_scrubbed": false,
      "body_scrub_reason": null,    // admin projection: may be 'gdpr'|'admin_redaction'|'sender_delete'
      "gdpr_erased_at": null,       // admin projection: included (not user-facing)
      "admin_visible": true,
      "contact_info_detected": false,
      "moderation_flagged": false,
      "created_at": "2026-05-09T10:00:00Z"
    }
  ],
  "next_cursor": "base64...",
  "total_admin_visible": 42
}

// 403 — caller role is not admin or moderator
// 404 — deal_id not found or no conversation for this deal
```

**SSE for admin readers — DEFERRED (v1.1)**

Admin moderators use `GET /admin/deals/{deal_id}/messages` (REST polling) during dispute review. No SSE stream is provided for admin consumers in v1.1. Rationale: dispute review is a low-frequency human-driven workflow; REST polling is sufficient and avoids a distinct SSE auth path on the fan-out infrastructure. SSE for admin is documented as a v1.2 candidate if real-time dispute dashboards are required.

**`GET /conversations/{id}/events` (SSE)**

```
event: message.received
data: {"message_id":"uuid","sender_id":"uuid","body":"...","created_at":"..."}

event: message.read
data: {"message_id":"uuid","reader_id":"uuid","read_at":"..."}

event: message.edited
data: {"message_id":"uuid","new_body":"...","edited_at":"..."}

event: message.deleted
data: {"message_id":"uuid","deleted_at":"..."}

event: typing
data: {"user_id":"uuid","typing":true}

event: cursor_reset
data: {"reason":"stale_cursor"}     # gap-fill could not locate last_message_id

event: heartbeat
data: {}                            # every 25 s
```

Gap-fill on reconnect: if `sse_cursors.last_message_id IS NULL` OR the referenced message row is not found, fall back to `created_at >= now() - INTERVAL '7 days'` ordered ascending; emit a `cursor_reset` event before replay.

### 4.8 Outbox Events Emitted by Messaging

| event_type | aggregate_type | aggregate_id | When | Payload |
|---|---|---|---|---|
| `message.created` | `message` | message UUID | After commit on message INSERT | `{conversation_id, message_id, sender_id, recipient_id, snippet}` |
| `conversation.created` | `conversation` | conversation UUID | New row created | `{conversation_id, scope, initiator_id, other_party_id, listing_id?, deal_id?}` |
| `conversation.blocked` | `conversation` | conversation UUID | Block inserted | `{conversation_id, blocker_id, blocked_id}` |
| `message.reported` | `message` | report UUID | Report submitted | `{message_id, reporter_id, reason, conversation_id}` |
| `message.contact_info_detected` | `message` | message UUID | Regex match | `{message_id, sender_id, conversation_id, patterns}` |
| `message.attachment_threat` | `message` | message UUID | Scan returns threat | `{message_id, media_object_id, conversation_id}` |
| `message.auto_redacted` | `message` | message UUID | Admin redaction action | `{message_id, sender_id, reason}` |
| `user.gdpr_erased_messages` | `user` | user UUID | Erasure complete | `{erased_user_id}` |

### 4.9 Rate Limits (Redis Lua atomic counters)

| Action | Limit |
|---|---|
| `POST /messages` | 30/min/user; 200/hour/user |
| `POST /conversations` | 10/min/user; 5 new conversations/hour/user |
| New account < 24 h old | max 2 total conversations |
| `POST /typing` | 5/sec/user (Redis-only, no DB) |
| `POST /report` | 5/hour/user |
| `POST /block` | 10/hour/user |
| `PATCH` / `DELETE` (edit/delete) | 10/min/user |

Keys follow Category Tree §4.8 pattern: `rl:msg:send:user:{user_id}:{YYYYMMDDHHmm}` etc., with TTL set to the bucket window + 1.

## 5. Acceptance Criteria

- **AC-001** — Given a `pre_deal` create against a listing with `status <> 'active'`, When the request fires, Then the response is `404 not_found` (uniform with non-existent listing).
- **AC-002** — Given a `deal`-scope create against a deal in terminal state, When the request fires, Then the response is `409 deal_in_terminal_state`.
- **AC-003** — Given a sender already at 5 attached `media_objects` for a message, When a 6th attachment upload is initiated under concurrent INSERTs, Then the advisory lock serializes and the 6th returns `422 message_attachment_limit_exceeded`.
- **AC-004** — Given a sender suspended at time T, When the sender attempts to send within the 15-minute JWT TTL, Then the same-TX `users.status` re-read returns the suspended status and the response is `403 account_suspended`.
- **AC-005** — Given an active block `(blocker=B, blocked=A)`, When A sends to a conversation between A and B, Then the response is `403 blocked` and no `messages` row is inserted.
- **AC-006** — Given concurrent `POST /block` and `POST /messages` with the mandatory advisory lock acquired in both transactions, When both run, Then the message is rejected (block effective) OR the message commits before the block; never both commit, never the block commits before a "racing" message slipped through.
- **AC-007** — Given a message with `created_at < now() - 10 minutes`, When the sender attempts PATCH, Then the response is `409 edit_window_expired`.
- **AC-008** — Given a `user.gdpr_erased_*` event, When the handler runs, Then `messages.body=NULL`, `body_scrubbed=TRUE`, `body_scrub_reason='gdpr'`, `gdpr_erased_at` set; the public API renders the message as `[повідомлення видалено]` and the JSON response omits both `gdpr_erased_at` and `body_scrub_reason`.
- **AC-009** — Given a stale `sse_cursors.last_message_id` referencing a purged message, When the user reconnects, Then the SSE stream emits `cursor_reset` and replays messages within the last 7 days.
- **AC-010** — Given a Redis cache miss for `msg:unread_total:{user}`, When the rebuild executes, Then a single SQL query is executed (not N) and the result equals `SUM` over per-conversation unread for that user.
- **AC-011** — Given a sender accumulating contact-info detections, When the count reaches `≥5 in 7 days` AND `messaging_user_state.contact_block_confirmed=FALSE`, Then the message is flagged but NOT blocked, AND a Module 9 `admin_notifications` row is created. After admin acknowledges and `contact_block_confirmed=TRUE`, the next threshold breach auto-blocks for 1 hour without re-confirmation.
- **AC-012** — Given `message_reports` rows with `status IN ('actioned','dismissed') AND created_at < now() - 12 months`, When the daily sweep runs, Then those rows are hard-deleted.
- **AC-013** — Given `sse_cursors` rows with `last_seen_at < now() - 90 days`, When the weekly sweep runs, Then those rows are hard-deleted.
- **AC-014** — Given a `message.created` outbox event with `aggregate_type='message'`, When the Notifications v1.1 worker scans, Then the event is consumed and a `new_message_for_recipient` notification is dispatched per the v1.1 catalog (in_app + push).
- **AC-015** — Given a successful `mark_read` transaction, When the post-commit hook fires, Then Redis `msg:unread:{user}:{conv}` is DELed; given a TX failure, Then no DEL is issued and the cache expires at the 300 s TTL.
- **AC-016** — Given a deal in `disputed` status, When a party sends a message, Then the inserted `messages` row has `admin_visible = TRUE` and the `deal_status` CTE used `FOR SHARE` to read `deals.status` within the same transaction.
- **AC-017** — Given a deal that transitions to `disputed`, When the outbox consumer processes `deal.status_changed{new_status: 'disputed'}`, Then all prior messages in the deal's conversation are updated to `admin_visible = TRUE` in a single UPDATE statement, and a `deal.messages_made_admin_visible` outbox event is emitted.
- **AC-018** — Given the outbox consumer for AC-017 runs twice (retry), Then the second run is a no-op (UPDATE affects 0 rows because `WHERE admin_visible = FALSE` matches nothing).
- **AC-019** — Given a dispute that resolves, When new messages are sent post-resolution, Then new messages have `admin_visible = FALSE`; existing messages from the dispute period retain `admin_visible = TRUE`.
- **AC-020** — Given a GDPR erasure for a user with messages where `admin_visible = TRUE`, When the handler runs, Then `body = NULL`, `body_scrubbed = TRUE`, `gdpr_erased_at` is set, AND `admin_visible` remains `TRUE` on those rows.
- **AC-021** — Given a caller with role `moderator` or `admin`, When `GET /api/v1/admin/deals/{deal_id}/messages` is called, Then only messages with `admin_visible = TRUE` are returned, including `gdpr_erased_at` and `body_scrub_reason` columns.
- **AC-022** — Given a caller without `admin` or `moderator` role, When `GET /api/v1/admin/deals/{deal_id}/messages` is called, Then the response is `403`.

## 6. Test Automation Strategy

- **Test Levels:** Unit (regex set, advisory-lock key derivation, FTS dictionary fallback DO block, GDPR projection rule); Integration (PG + Redis ephemeral containers; concurrent block/send race; GDPR sweep; retention sweeps); End-to-End (SSE reconnect, cursor reset, attachment cap under load).
- **Frameworks:** project-default backend test stack (parity with prior modules).
- **Test Data:** fixture seeds for `notification_types` (Notifications v1.1 catalog rows), `contact_info_allowlist`, synthetic `outbox_events`. Deterministic `now()` injection for retention sweep tests.
- **CI/CD:** integration tests run on every PR. SSE reconnect tests exercise both fresh and stale cursors. The CI Postgres image MUST be tested both with and without the `'ukrainian'` text-search dictionary to validate the DO block fallback.
- **Coverage:** ≥85% line coverage on the Messaging service.
- **Performance:** sustained 1k msg/sec for 30 minutes; assert p99 send latency < 250 ms with the advisory-lock acquired; assert SSE p99 fan-out latency < 200 ms via Redis pub/sub.
- **Concurrency:** two-process tests for block-vs-send (advisory lock correctness); two-process tests for attachment-cap enforcement; chaos test for Redis flush during inbox load (verifies single-query rebuild path).

## 7. Rationale & Context

The orchestration loop produced 20 R1 decisions; CRITIC R1 issued 12 risks (REJECT). R2 refinements addressed each but introduced seven new correction-class risks plus three carry-forwards (REJECT). R3 corrections converged the design.

Key rationale:

- **Two scopes only (REQ-001/002)** — Free conversations bypass marketplace accountability (escrow, dispute, GDPR scope). Anchoring every conversation to a listing or deal preserves auditability and provides a natural lock target on deal terminal states. Provider-initiated cold contact is the primary spam vector and is explicitly forbidden.
- **Synchronous deal terminal-state check (REQ-002)** — The lock-by-deal outbox consumer handles already-open conversations, but a synchronous check at create time is required to close the consumer-lag window during which a new conversation could be opened against a just-completed deal.
- **Mandatory advisory lock for block/send (MSG-SEC-002, GUD-005)** — `FOR SHARE` on existing block rows does not lock the absence of a row; only an advisory lock on the `(min(sender,recipient), max(sender,recipient))` key serializes block-insert against send-insert deterministically. The 1-arg BIGINT form via `hashtextextended` avoids the 32-bit collision space of the 2-arg INT4 form.
- **Lazy unread counter (REQ-010, R4 carry-forward)** — Trigger-based denormalization on `conversations` creates hot-row contention serializing all sends in a conversation. Lazy compute backed by a partial index plus Redis cache (post-commit-only invalidation) eliminates that contention while preserving inbox-load latency.
- **MSG-SEC-001 same-TX status re-read** — JWT TTL is 15 minutes; harassment bursts during the revocation lag are unacceptable on a write path. Mirroring Auth SEC-006 elevates this to a formal security requirement, not a narrative note.
- **GDPR projection rule (REQ-019)** — Exposing `gdpr_erased_at` in API responses leaks the timing and existence of an erasure event, which is itself residual PII under GDPR Recital 26. Treating it identically to `deleted_at` in user-facing rendering closes the leak while preserving internal compliance audit visibility.
- **Media Pipeline v1.1 amendment (CON-001)** — Adding `purpose='message_attachment'` is the GUD-005 contract path in the Media Pipeline. The amendment also adds `message_id` as a top-level FK on `media_objects` (no separate scan_status duplication), reuses the advisory-lock cap pattern, and updates `chk_exactly_one_owner` to accept message attachments with `owner_user_id IS NULL`.
- **Notifications v1.1 amendment (CON-002)** — The Notifications worker scan filter `aggregate_type IN ('deal','review','user')` excludes `message` and `conversation`. Module 10 cannot ship until this is amended and the §4.6 catalog has dispatch rows for the three new notification codes; otherwise events are silently consumed by the cursor advance with no notification sent.
- **'simple' FTS at MVP (CON-004)** — The `'ukrainian'` configuration is not universally available on cloud Postgres providers. The `'simple'` configuration is portable but does not handle Ukrainian morphology. The DO-guarded opportunistic `'ukrainian'` GIN index is created when the dictionary is present; the application query continues to use `'simple'` for portability. This is a documented MVP limitation with a clear v1.1 upgrade path.
- **admin_visible backfill via outbox consumer, not trigger (REQ-021, v1.1)** — A PostgreSQL trigger on `deals.status` firing a cross-table UPDATE on `messages` creates hidden cross-module coupling: a write to the Deal schema silently modifies the Messaging schema, violating the module-isolation contract established across this spec suite. Triggers that UPDATE rows in a different logical service are invisible to the application layer, making distributed tracing, error handling, and idempotent retries impossible without PL/pgSQL error propagation hacks. The outbox consumer is the established pattern for cross-module side effects in this system (Category Tree §4.3). The consumer UPDATE is idempotent (`WHERE admin_visible = FALSE`), re-runnable on failure, and traceable via the `deal.messages_made_admin_visible` outbox event. The only cost is consumer processing lag (typically < 1 s), during which prior messages have not yet been flagged; this is acceptable for a dispute review workflow where admin access is not instantaneous.
- **admin_visible flag permanence after dispute resolution (REQ-021, v1.1)** — Messages flagged during a dispute are not reverted when the dispute resolves. The flagged set is the evidentiary record for adjudication; reverting it would destroy the audit trail. The flag is append-only in the TRUE direction. New messages after resolution are `admin_visible = FALSE` by the send pipeline's deal_status CTE (non-disputed status → COALESCE → FALSE).
- **GDPR body NULL does not clear admin_visible (REQ-021 + REQ-018, v1.1)** — GDPR Article 17 requires erasure of personal data content (the message body). The `admin_visible` flag is structural/audit metadata, not personal data within the meaning of GDPR Recital 26. Clearing it would impair the completeness of the dispute audit log without serving any GDPR purpose. The admin endpoint renders erased bodies as null and retains the flag and erasure metadata columns for compliance audit.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** — none (Messaging is internally hosted; push/email delivery is handled by Notifications via outbox).

### Third-Party Services
- **SVC-001** — none directly; Notifications consumes Messaging outbox events to invoke push/email providers.

### Infrastructure Dependencies
- **INF-001** — PostgreSQL 15+ shared cluster. Required tables: `users`, `user_profiles`, `listings`, `deals`, `media_objects`, `outbox_events`, plus this module's tables.
- **INF-002** — Redis 7+ for rate limiting, unread caches, SSE pub/sub fan-out.
- **INF-003** — SSE-capable HTTP/2 reverse proxy (terminate keep-alives, no buffering).

### Data Dependencies
- **DAT-001** — `outbox_events` (Category Tree §4.3) — emission target and consumer-source for `lock-by-deal`.
- **DAT-002** — `users.status`, `user_roles` for admin endpoints, GDPR cascade.
- **DAT-003** — `listings.status` for pre-deal create gate.
- **DAT-004** — `deals.status, client_id, provider_id` for deal-scope create gate.

### Technology Platform Dependencies
- **PLT-001** — PostgreSQL ≥ 11 for `hashtextextended` (1-arg BIGINT advisory locks). Robotun project default is PG 15+, requirement satisfied.
- **PLT-002** — `pg_cron` or platform scheduler for retention sweeps.

### Compliance Dependencies
- **COM-001** — GDPR Article 17 (right to erasure) — implemented via REQ-018, AC-008.
- **COM-002** — Ukrainian "Закон про захист персональних даних" — same as GDPR scope for messaging PII.

## 9. Examples & Edge Cases

### 9.1 Conversation create response

```json
POST /api/v1/conversations
{ "scope": "pre_deal", "listing_id": "uuid", "provider_id": "uuid" }

201 Created
{
  "id": "uuid",
  "scope": "pre_deal",
  "listing_id": "uuid",
  "client_id": "uuid",
  "provider_id": "uuid",
  "status": "open",
  "last_message_at": null,
  "created_at": "2026-05-08T12:00:00Z"
}
```

### 9.2 GDPR-erased message in API response

Internal row state:
```
body=NULL, body_scrubbed=TRUE, body_scrub_reason='gdpr', gdpr_erased_at='2026-04-30T10:00:00Z'
```

API JSON projection:
```json
{
  "id": "uuid",
  "conversation_id": "uuid",
  "sender_id": null,
  "body": "[повідомлення видалено]",
  "deleted_at": null,
  "created_at": "2026-04-15T08:30:00Z"
}
```
`gdpr_erased_at` and `body_scrub_reason` are absent.

### 9.3 Edge case — repeat conversation creation idempotent

A Client posts twice with the same `(listing_id, provider_id)` payload. Both calls return the same conversation `id`, the first as `201`, the second as `200`. UNIQUE `(listing_id, client_id, provider_id)` plus `INSERT ... ON CONFLICT DO NOTHING` then `SELECT` fallback.

### 9.4 Edge case — block during in-flight send

A sends a message; B blocks A. Both transactions acquire `pg_advisory_xact_lock(hashtextextended('block_pair:<min>:<max>:'…, 0))`. Whichever commits first wins: if A's send commits first, the message lands and the block applies to all subsequent sends; if B's block commits first, A's send sees the block_check CTE return a row and inserts zero rows.

### 9.5 Edge case — listing paused mid-create

User probes a listing that flips from `active` to `paused` between page load and conversation create. The `SELECT id FROM listings WHERE id=$ AND status='active' FOR SHARE` returns 0 rows under `READ COMMITTED` after the paused commit; response is `404`. No enumeration sidechannel: identical 404 for non-existent UUIDs.

## 10. Validation Criteria

A compliant implementation MUST:

1. Pass AC-001 through AC-015 in CI.
2. Fail the build if Media Pipeline v1.1 or Notifications v1.1 amendments are absent at deploy time (deploy-time check on `media_objects.purpose` CHECK and on Notifications worker allowlist string).
3. Reject any code path that writes to `users.contact_block_confirmed` or any column on the Auth-owned `users` table from the Messaging service.
4. Reject any API response that includes `gdpr_erased_at` or `body_scrub_reason` keys for non-internal endpoints.
5. Reject any send path that does not acquire the mandatory block-pair advisory lock before the block-check CTE.
6. Reject any send path that omits the same-TX `users.status` re-read (MSG-SEC-001).
7. Verify single-query unread-total rebuild via integration test asserting the explain plan does NOT contain N joins.
8. Reject any `pg_advisory_xact_lock` call using the 2-arg INT4 form for block-pair or attachment-cap keys.
9. Provide retention-sweep test fixtures for `message_reports` (12-mo + 30-d orphan) and `sse_cursors` (90-d).

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `users`, account states, JWT model, GDPR cascade. MSG-SEC-001 mirrors Auth SEC-006.
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — `outbox_events` DDL §4.3.
- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — deal terminal states; source of `lock-by-deal` consumer events.
- [`spec/spec-architecture-listings.md`](./spec-architecture-listings.md) — listing visibility gate `status='active'`; SEC-003 enumeration uniformity pattern.
- [`spec/spec-architecture-media-pipeline.md`](./spec-architecture-media-pipeline.md) — v1.1 (CON-001 satisfied): adds `purpose='message_attachment'`, `message_id` column (FK added in Messaging deploy migration), advisory-lock cap pattern. See §4.1.1.
- [`spec/spec-architecture-notifications.md`](./spec-architecture-notifications.md) — v1.1 (CON-002 satisfied): worker scan allowlist `IN ('deal','review','user','message','conversation')`; §4.6 catalog adds `new_message_for_recipient`, `conversation_blocked_confirmation`, `message_redacted_for_sender`.
- [`spec/spec-architecture-reviews.md`](./spec-architecture-reviews.md) — REQ-026 retention sweep pattern mirrored as MSG-REQ-016.
- [`spec/spec-design-disputes-ui-flow.md`](./spec-design-disputes-ui-flow.md) — Module 14: Disputes UI flow. Requires `admin_visible` messaging (v1.1). Explicitly rejects conversation locking during `disputed` state; mandates conversation stays open for both parties with full admin/moderator read visibility.
- RFC 5322 — Email format (used in contact-info regex).
- E.164 — International phone numbering plan.
