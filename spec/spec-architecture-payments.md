---
title: Payments — Escrow Consumer, Ledger, Payouts, PSP Abstraction
version: 1.0
date_created: 2026-05-08
last_updated: 2026-05-08
owner: Platform / Payments
tags: [architecture, payments, escrow, ledger, psp, payouts, refunds, chargebacks, reconciliation, gdpr, pci]
---

# Introduction

Module 11 — Payments owns all money movement on the Robotun marketplace: it consumes deal-escrow events from the transactional outbox, calls the Payment Service Provider (PSP) to hold/capture/refund/payout, maintains a double-entry ledger, exposes provider wallet and payout APIs, processes PSP webhooks, and runs daily reconciliation against PSP statements. It is the system of record for funds in transit, escrow balances, platform fee revenue, and chargeback liability. It is NOT the system of record for legal escrow funds — those live in the PSP's regulated escrow account (LiqPay at MVP).

## 1. Purpose & Scope

This specification defines:

- The escrow consumer that polls `outbox_events` for deal-escrow events and dispatches PSP calls.
- The double-entry ledger model: 5 system accounts + per-user wallet, append-only `ledger_entries`, deferred SUM(debit)=SUM(credit) trigger, denormalized `wallet_balances` cache.
- The PSP `PaymentProvider` interface and concrete LiqPay primary implementation. Fondy + Stripe are stubs at MVP.
- Three-phase PSP charge sequencing with `psp_call_log` micro-TX (PAY-PAT-003) for orphan recovery.
- Webhook receipt as a transactional inbox (verify → INSERT processed=false → COMMIT → 200; separate poller).
- Payout flow: KYC same-TX gate (mirrors MSG-SEC-001), manual-review threshold, idempotency-keyed dispatch.
- Refunds, partial releases (split), chargebacks (full state machine including arbitration reversals).
- Daily reconciliation per PSP, discrepancy queue, admin resolution.
- Hold-expiry monitoring, dual-event emission for v1.2-independent Notifications routing.
- GDPR retention: 7y for ledger, 3y for operational PII columns; NULL-on-erase semantics.

**Hard prerequisites — Module 11 cannot ship before BOTH amendments land:**

1. **Deal spec v1.2** — adds `deal.cancelled_hold_expired` and `deal.escrow_hold_warning` events to §4.8.
2. **Notifications spec v1.2** — extends REQ-001 allowlist to include `payment`, `payout`, `refund`, `chargeback`, `wallet` aggregate types; adds 7 catalog rows (payout_*, refund_issued_*, chargeback_*_for_*, payment_failed_for_client).

**Audience:** backend, SRE, finance/compliance, security reviewers.

**Assumptions:** PostgreSQL 15+, Redis 7+, REST/JSON over HTTPS, JWT (RS256). Money in INTEGER kopecks (UAH). All timestamps `TIMESTAMPTZ` UTC. Outbox table from Category Tree §4.3.

**Out of scope:** multi-currency support, Stripe Connect production, instalments, multi-milestone escrow, KMS encryption of `psp_raw_response` (no PAN stored), AML/sanctions screening, hold-extension API integration (deferred to integration spike), Fondy/Stripe production implementations, client-facing card vault UI (PSP-hosted checkout only).

## 2. Definitions

- **PSP** — Payment Service Provider (LiqPay, Fondy, Stripe).
- **Escrow** — funds held by the platform (legally at PSP) on behalf of a Client until deal completion or cancellation.
- **Hold (pre-authorization)** — PSP pre-auth on Client card; not yet captured. 7-day cap on LiqPay.
- **Capture** — converts a hold into a settled charge against the Client.
- **Payout** — disbursement from a Provider's wallet balance to their bank account or card.
- **Chargeback** — Client-initiated dispute filed with the issuing bank, leading to a forced refund pending evidence review.
- **Idempotency key** — caller-supplied UUID guaranteeing at-most-once side effects.
- **Reconciliation** — daily comparison of PSP statement against `payment_events`.
- **Kopeck** — minor unit of UAH; 100 kopecks = 1 UAH. All amounts in this module are stored as `BIGINT` kopecks.
- **bps** — basis points; 1 bps = 0.01%; 1000 bps = 10%.
- **txn_group_id** — UUID grouping all `ledger_entries` rows that comprise one logical money movement; the SUM(debit)=SUM(credit) invariant is enforced per `txn_group_id`.
- **PCI SAQ-A** — PCI-DSS Self-Assessment Questionnaire A scope: applicable when card data is fully outsourced to a PCI-DSS-validated PSP (no PAN ever in our environment).

## 3. Requirements, Constraints & Guidelines

### Requirements

- **REQ-001** — The Payments worker consumes `outbox_events` with `aggregate_type='deal'` filtered to `event_type IN ('deal.escrow_hold_requested','deal.escrow_hold_cancelled','deal.escrow_release_requested','deal.escrow_refund_requested','deal.escrow_partial_release')`.
- **REQ-002** — The worker MUST NOT modify `outbox_events.status`. It maintains its own cursor in `payment_consumer_cursors` (same shape as `notification_consumer_cursors`).
- **REQ-003** — Single-active enforcement via `SELECT ... FOR UPDATE SKIP LOCKED` on the cursor row. 0 rows returned → sleep 5 s and retry.
- **REQ-004** — Money is stored exclusively as `BIGINT` kopecks. All amount columns have `CHECK (amount_kopecks > 0)` (or `>= 0` where appropriate). Currency MUST be `'UAH'`; DB CHECK + API validation.
- **REQ-005** — Double-entry ledger invariant: `SUM(debit) = SUM(credit)` per `txn_group_id`, enforced by a DEFERRED constraint trigger on `ledger_entries`.
- **REQ-006** — `ledger_entries` are append-only. RULE blocks UPDATE and DELETE at the DB level.
- **REQ-007** — `balance_after_kopecks` on every `ledger_entries` row MUST be derived from `UPDATE wallet_balances ... RETURNING` within the same statement (PAY-PAT-002), not from a separate pre-read.
- **REQ-008** — All `FOR UPDATE` locks on `wallet_balances` MUST be acquired in ascending `account_id` UUID order within a transaction (PAY-PAT-001).
- **REQ-009** — On `SQLSTATE 40P01` (deadlock_detected), the application retries the transaction with exponential backoff: 50 ms → 200 ms → 1000 ms, max 3 attempts; then HTTP 500.
- **REQ-010** — Three-phase PSP sequencing (PAY-PAT-003): (1) HTTP call, (2) micro-TX into `psp_call_log`, (3) mini-TX UPDATE `payment_events.status='processing'` + `psp_raw_response`, (4) main TX ledger writes + `status='succeeded'`.
- **REQ-011** — Recovery scanner: any `payment_events.status='processing' AND psp_raw_response<>'{}'::jsonb AND updated_at < now() - INTERVAL '5 minutes'` → replay phase 4. Any orphan in `psp_call_log` with no matching `payment_events.psp_reference_id` for 10 minutes → query PSP API by `request_idempotency_key`.
- **REQ-012** — Operational alert: any `payment_events.status='processing'` row older than 1 hour → P2 page.
- **REQ-013** — Webhook handling: signature-verify → INSERT `webhook_events (processed=false)` → COMMIT → 200. Separate poller drains via `FOR UPDATE SKIP LOCKED`. NO in-memory queue.
- **REQ-014** — Webhook replay protection: `UNIQUE (psp_provider, event_id_psp)` on `webhook_events`. `payload_hash = SHA-256(raw_body)` for audit dedup.
- **REQ-015** — Retry policy for PSP calls: `[0s, 30s±10s, 5m±30s, 30m±5m, 2h±15m]` max 5 attempts. PSP timeout 30 s. `5xx` retried; `4xx` terminal. After 5 failures: `status='failed'`, emit `payment.failed`.
- **REQ-016** — Payout KYC gate: same-TX SELECT joining `provider_profiles` and `kyc_verifications` with `FOR SHARE` on both rows. Block if `pp.payout_enabled IS NOT TRUE` OR `kv.status <> 'approved'`. Defense-in-depth — never rely solely on the denormalized `provider_profiles.kyc_status` column.
- **REQ-017** — Manual-review threshold: payouts above `platform_config.payout_manual_review_threshold_kopecks` (default 10 000 000 = 100 000 UAH) require admin approval before dispatch.
- **REQ-018** — Idempotency: `UNIQUE (idempotency_key, deal_id, event_type)` on `payment_events`; `UNIQUE (idempotency_key, provider_id)` on `payout_requests`. On collision, handler MUST verify scope match; mismatch → `409 idempotency_scope_conflict`.
- **REQ-019** — Platform fee: `FLOOR(release_amount_kopecks * fee_rate_bps / 10000)` applied to provider portion only at release time. Refund leg carries zero fee. Configurable via `platform_config.fee_rate_bps` (default 1000 = 10%).
- **REQ-020** — MVP deal duration cap: `≤ 6 days` from `escrow_held_at` (one PSP renewal headroom). `POST /deals` returns `422 deal_duration_exceeds_escrow_hold_limit` if requested duration exceeds the cap.
- **REQ-021** — Hold expiry monitoring: at `-24h` from `hold_expires_at`, emit `payment.hold_expiring` (internal) AND paired `deal.escrow_hold_warning` (Notifications consumes via existing `aggregate_type='deal'` allowlist). At `-1h`, attempt PSP renewal. On renewal failure: emit `payment.hold_expired` → Deal consumer triggers `deal.cancelled_hold_expired` (Deal v1.2).
- **REQ-022** — Reconciliation: daily 02:00 UTC per PSP. Discrepancy types: `amount_mismatch`, `ledger_missing`, `psp_missing`, `status_mismatch`. Auto-resolve `psp_missing` for `payment_events.status='pending'`. Manual queue otherwise.
- **REQ-023** — Reconciliation lock via `reconciliation_locks` table (INSERT ON CONFLICT DO NOTHING RETURNING). Orphan cleanup deletes rows older than 2 hours.
- **REQ-024** — `reconciliation_runs` partial UNIQUE INDEX on terminal statuses only: `WHERE status IN ('completed','failed_terminal')`. Allows multiple non-terminal rows per `(psp_provider, run_date)` for re-run on partial failure.
- **REQ-025** — Cursor lag monitoring: Prometheus gauge `payment_consumer_cursor_lag_events = MAX(outbox_events.id) - last_seen_id`. P2 alert when `> 1000` for 5 minutes.
- **REQ-026** — Outbox events emitted by Payments: `payment.captured`, `payment.failed`, `payment.hold_expiring`, `payment.hold_expired`, `payout.requested`, `payout.completed`, `payout.failed`, `refund.issued`, `refund.failed`, `chargeback.received`, `chargeback.won`, `chargeback.lost`, `chargeback.arbitration_won`, `chargeback.settled`, `wallet.balance_changed`, plus the paired `deal.escrow_hold_warning` (aggregate_type='deal').

### Security

- **PAY-SEC-001** — Payout dispatch handler MUST re-read `users.status`, `provider_profiles.payout_enabled`, and `kyc_verifications.status` from the primary database within the same transaction as the wallet debit. Mirrors Auth SEC-006 / Messaging MSG-SEC-001. JWT claims MUST NOT be sole authority.
- **PAY-SEC-002** — PCI-DSS scope: SAQ-A. PSP-tokenized card/IBAN data only. NEVER store raw PAN, CVV, full IBAN, or expiry date. `payout_methods.psp_token` is opaque vault reference; `display_hint` is masked (e.g., `****1234`).
- **PAY-SEC-003** — Webhook signing keys MUST be stored in environment secrets (e.g., Vault, AWS Secrets Manager). NEVER in DB. NEVER in logs.
- **PAY-SEC-004** — Webhook signature verification uses constant-time comparison (`crypto.timingSafeEqual` or equivalent) for all PSPs. Stripe webhooks additionally require `|now() - timestamp| ≤ 300s` (5-minute replay window).
- **PAY-SEC-005** — Webhook signing key rotation: dual-verification window of 1 hour during which both old and new signatures are accepted; old key retired after window.
- **PAY-SEC-006** — Internal endpoints (`POST /internal/webhooks/{psp}`) authenticate via PSP signature only; mTLS deferred per CON-006.
- **PAY-SEC-007** — `psp_raw_response` JSONB MUST NOT contain PAN, CVV, or full IBAN. PSP responses contain only tokenized references; sanitization applied before persistence.
- **PAY-SEC-008** — Admin endpoints (`/api/v1/admin/*`) require `admin` or `moderator` role re-read from `user_roles` in the same transaction (mirrors Notifications SEC-005).

### Constraints

- **CON-001** — Module 11 cannot ship before Deal spec v1.2 amendment is finalized and deployed (adds `deal.cancelled_hold_expired` and `deal.escrow_hold_warning`).
- **CON-002** — Module 11 cannot ship before Notifications spec v1.2 amendment is finalized and deployed (adds payment/payout/refund/chargeback/wallet aggregate types to REQ-001 allowlist + §4.6 catalog rows).
- **CON-003** — UAH-only at MVP. DB CHECK + API validation. Multi-currency requires schema migration + PSP renegotiation; out of scope.
- **CON-004** — LiqPay is the only production-wired PSP at MVP. Fondy and Stripe are interface stubs; abstraction allows swap without business-logic changes.
- **CON-005** — Deal duration ≤ 6 days from `escrow_held_at`. Multi-renewal flow deferred to v1.1.
- **CON-006** — mTLS for `/internal/webhooks/*` endpoints deferred. PSP signature + network ACLs are the v1 control. Re-evaluate at v2 when PCI scope expands.
- **CON-007** — Redis is best-effort for any caching; PostgreSQL is authoritative for ledger and balance state.
- **CON-008** — `ledger_entries` table is unpartitioned at MVP. Revisit at ~50M rows.

### Guidelines

- **PAY-GUD-001** — Prefer pre-authorization (hold) over charge-then-refund. Charge dispute rates are higher when refunds are issued.
- **PAY-GUD-002** — When in doubt about PSP semantics, query the PSP API by `request_idempotency_key`. Recovery is the canonical path; speculative retries without query risk double-charge.
- **PAY-GUD-003** — Document any PSP-specific assumption (e.g., "LiqPay holds expire at 7 days") with the PSP doc URL in code comments at the integration boundary.
- **PAY-GUD-004** — All retention sweeps MUST be NULL-on-expiry, not DELETE-on-expiry, for any row referenced by `ledger_entries.deal_id` or `payment_events.id`. Ledger integrity outranks PII minimization for financial records.

### Patterns

- **PAY-PAT-001** — Canonical lock ordering: all `FOR UPDATE` on `wallet_balances` in ascending `account_id` UUID order.
- **PAY-PAT-002** — `balance_after_kopecks` derived from `UPDATE ... RETURNING` within the same statement.
- **PAY-PAT-003** — Three-phase PSP charge sequencing: HTTP call → `psp_call_log` micro-TX → `payment_events` mini-TX → main ledger TX.
- **PAY-PAT-004** — Transactional inbox for webhooks: synchronous INSERT-and-200, async drain via `FOR UPDATE SKIP LOCKED`.

## 4. Interfaces & Data Contracts

### 4.1 Schema (PostgreSQL 15+)

```sql
-- 4.1.1 Enums
CREATE TYPE ledger_account_type AS ENUM (
  'user_wallet','escrow_holding','platform_fee','gateway_in_flight',
  'payout_in_flight','chargeback_liability'
);
CREATE TYPE ledger_direction      AS ENUM ('debit','credit');
CREATE TYPE payment_event_type    AS ENUM (
  'escrow_hold','escrow_hold_cancel','escrow_release','escrow_refund',
  'escrow_partial_release','payout','chargeback_received','chargeback_won',
  'chargeback_lost','chargeback_arbitration_won','chargeback_settled',
  'reconciliation_adjustment','hold_renewal'
);
CREATE TYPE payment_event_status  AS ENUM (
  'pending','processing','succeeded','failed','cancelled'
);
CREATE TYPE payout_method_type    AS ENUM ('iban','card');
CREATE TYPE payout_status         AS ENUM (
  'pending_kyc','queued','manual_review','processing','completed','failed','cancelled'
);
CREATE TYPE chargeback_status     AS ENUM (
  'received','won','lost','arbitration','arbitration_won','settled'
);
CREATE TYPE recon_status          AS ENUM ('open','auto_resolved','manual_resolved','escalated');
CREATE TYPE recon_run_status      AS ENUM ('running','completed','failed','failed_terminal');

-- 4.1.2 platform_config (key-value)
CREATE TABLE platform_config (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seed:
-- INSERT INTO platform_config VALUES ('fee_rate_bps','1000', now());
-- INSERT INTO platform_config VALUES ('payout_manual_review_threshold_kopecks','10000000', now());
-- INSERT INTO platform_config VALUES ('hold_renewal_warning_hours','24', now());

-- 4.1.3 ledger_accounts
CREATE TABLE ledger_accounts (
  id           UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type ledger_account_type NOT NULL,
  owner_id     UUID                REFERENCES users(id) ON DELETE RESTRICT,
  currency     CHAR(3)             NOT NULL DEFAULT 'UAH' CHECK (currency = 'UAH'),
  created_at   TIMESTAMPTZ         NOT NULL DEFAULT now(),
  CONSTRAINT chk_user_wallet_has_owner
    CHECK (account_type <> 'user_wallet' OR owner_id IS NOT NULL),
  CONSTRAINT chk_system_account_no_owner
    CHECK (account_type = 'user_wallet' OR owner_id IS NULL)
);
CREATE UNIQUE INDEX uq_ledger_account_user_wallet
  ON ledger_accounts (owner_id) WHERE account_type = 'user_wallet';
CREATE UNIQUE INDEX uq_ledger_account_system_type
  ON ledger_accounts (account_type) WHERE account_type <> 'user_wallet';

-- 4.1.4 ledger_entries (append-only, double-entry)
CREATE TABLE ledger_entries (
  id                    BIGSERIAL        PRIMARY KEY,
  txn_group_id          UUID             NOT NULL,
  account_id            UUID             NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  deal_id               UUID             REFERENCES deals(id) ON DELETE RESTRICT,
  payment_event_id      UUID,            -- FK to payment_events.id (nullable)
  direction             ledger_direction NOT NULL,
  amount_kopecks        BIGINT           NOT NULL CHECK (amount_kopecks > 0),
  balance_after_kopecks BIGINT           NOT NULL,  -- from UPDATE wallet_balances ... RETURNING (PAY-PAT-002)
  description           TEXT             NOT NULL,
  created_at            TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_entries_txn_group ON ledger_entries (txn_group_id);
CREATE INDEX idx_ledger_entries_account   ON ledger_entries (account_id, created_at DESC);
CREATE INDEX idx_ledger_entries_deal      ON ledger_entries (deal_id, created_at DESC) WHERE deal_id IS NOT NULL;

-- Append-only enforcement
CREATE RULE ledger_entries_no_delete AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_entries_no_update AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;

-- DEFERRED double-entry invariant trigger
CREATE OR REPLACE FUNCTION trg_check_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE net BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_kopecks ELSE -amount_kopecks END), 0)
    INTO net FROM ledger_entries WHERE txn_group_id = NEW.txn_group_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'ledger imbalance for txn_group_id %: net = %', NEW.txn_group_id, net
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_ledger_balance_check
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_check_ledger_balance();

-- 4.1.5 wallet_balances (denormalized cache)
CREATE TABLE wallet_balances (
  account_id        UUID        PRIMARY KEY REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  available_kopecks BIGINT      NOT NULL DEFAULT 0 CHECK (available_kopecks >= 0),
  frozen_kopecks    BIGINT      NOT NULL DEFAULT 0 CHECK (frozen_kopecks >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.1.6 payment_events
CREATE TABLE payment_events (
  id               UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id          UUID                  REFERENCES deals(id) ON DELETE RESTRICT,
  event_type       payment_event_type    NOT NULL,
  status           payment_event_status  NOT NULL DEFAULT 'pending',
  idempotency_key  TEXT                  NOT NULL,
  psp_provider     TEXT                  NOT NULL CHECK (psp_provider IN ('liqpay','fondy','stripe')),
  psp_reference_id TEXT,
  amount_kopecks   BIGINT                NOT NULL CHECK (amount_kopecks > 0),
  currency         CHAR(3)               NOT NULL DEFAULT 'UAH' CHECK (currency = 'UAH'),
  txn_group_id     UUID,
  attempt_count    SMALLINT              NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ           NOT NULL DEFAULT now(),
  hold_expires_at  TIMESTAMPTZ,                   -- set for escrow_hold events
  last_error       TEXT,
  psp_raw_response JSONB                 NOT NULL DEFAULT '{}'::jsonb,
  metadata         JSONB                 NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ           NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ           NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_event_idempotency UNIQUE (idempotency_key, deal_id, event_type)
);
CREATE INDEX idx_payment_events_deal     ON payment_events (deal_id, created_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX idx_payment_events_pending  ON payment_events (next_retry_at) WHERE status IN ('pending','processing');
CREATE INDEX idx_payment_events_psp_ref  ON payment_events (psp_provider, psp_reference_id) WHERE psp_reference_id IS NOT NULL;
CREATE INDEX idx_payment_events_holds    ON payment_events (hold_expires_at) WHERE hold_expires_at IS NOT NULL AND status = 'succeeded';
CREATE TRIGGER set_payment_events_updated_at
  BEFORE UPDATE ON payment_events FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- 4.1.7 psp_call_log (PAY-PAT-003 phase-1 atomicity probe)
CREATE TABLE psp_call_log (
  id                      BIGSERIAL    PRIMARY KEY,
  payment_event_id        UUID         NOT NULL REFERENCES payment_events(id) ON DELETE RESTRICT,
  psp_provider            TEXT         NOT NULL,
  request_idempotency_key TEXT         NOT NULL,
  request_method          TEXT         NOT NULL,
  request_path            TEXT         NOT NULL,
  response_received_at    TIMESTAMPTZ,
  response_body_hash      TEXT,
  response_metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_psp_call_idempotency UNIQUE (request_idempotency_key)
);
CREATE INDEX idx_psp_call_log_event       ON psp_call_log (payment_event_id);
CREATE INDEX idx_psp_call_log_orphan_scan ON psp_call_log (created_at) WHERE response_received_at IS NOT NULL;

-- 4.1.8 payout_methods (PSP-tokenized only)
CREATE TABLE payout_methods (
  id           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID               NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  method_type  payout_method_type NOT NULL,
  psp_token    TEXT               NOT NULL,        -- opaque PSP vault reference
  display_hint TEXT,                              -- nullable for GDPR erasure
  psp_provider TEXT               NOT NULL CHECK (psp_provider IN ('liqpay','fondy','stripe')),
  is_default   BOOLEAN            NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ        NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_payout_methods_provider ON payout_methods (provider_id) WHERE deleted_at IS NULL;

-- 4.1.9 payout_requests
CREATE TABLE payout_requests (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id              UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payout_method_id         UUID          NOT NULL REFERENCES payout_methods(id) ON DELETE RESTRICT,
  amount_kopecks           BIGINT        NOT NULL CHECK (amount_kopecks > 0),
  currency                 CHAR(3)       NOT NULL DEFAULT 'UAH' CHECK (currency = 'UAH'),
  status                   payout_status NOT NULL DEFAULT 'queued',
  payment_event_id         UUID          REFERENCES payment_events(id) ON DELETE RESTRICT,
  idempotency_key          TEXT          NOT NULL,
  payout_destination_hint  TEXT,         -- snapshot at dispatch; retained 3y, NULLed by retention sweep
  payout_destination_bank  TEXT,         -- snapshot at dispatch; retained 3y
  manual_review_reason     TEXT,
  reviewed_by_admin_id     UUID          REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at              TIMESTAMPTZ,
  psp_reference_id         TEXT,
  failed_reason            TEXT,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_payout_idempotency UNIQUE (idempotency_key, provider_id)
);
CREATE INDEX idx_payout_requests_provider ON payout_requests (provider_id, created_at DESC);
CREATE INDEX idx_payout_requests_queued   ON payout_requests (created_at) WHERE status = 'queued';
CREATE INDEX idx_payout_requests_manual   ON payout_requests (created_at) WHERE status = 'manual_review';
CREATE TRIGGER set_payout_requests_updated_at
  BEFORE UPDATE ON payout_requests FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- 4.1.10 webhook_events (transactional inbox)
CREATE TABLE webhook_events (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  psp_provider     TEXT         NOT NULL CHECK (psp_provider IN ('liqpay','fondy','stripe')),
  event_id_psp     TEXT         NOT NULL,
  event_type_psp   TEXT         NOT NULL,
  payload          JSONB        NOT NULL,
  payload_hash     TEXT         NOT NULL,
  processed        BOOLEAN      NOT NULL DEFAULT false,
  payment_event_id UUID         REFERENCES payment_events(id) ON DELETE SET NULL,
  received_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  error_detail     TEXT,
  CONSTRAINT uq_webhook_psp_event UNIQUE (psp_provider, event_id_psp)
);
CREATE INDEX idx_webhook_events_unprocessed ON webhook_events (received_at) WHERE processed = false;

-- 4.1.11 chargebacks
CREATE TABLE chargebacks (
  id                    UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_event_id      UUID              NOT NULL REFERENCES payment_events(id) ON DELETE RESTRICT,
  deal_id               UUID              REFERENCES deals(id) ON DELETE RESTRICT,
  psp_chargeback_id     TEXT              NOT NULL UNIQUE,
  amount_kopecks        BIGINT            NOT NULL CHECK (amount_kopecks > 0),
  reason_code           TEXT              NOT NULL,
  status                chargeback_status NOT NULL DEFAULT 'received',
  funds_frozen_at       TIMESTAMPTZ,
  evidence_due_by       TIMESTAMPTZ,
  evidence_submitted_at TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  admin_notes           TEXT,
  created_at            TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ       NOT NULL DEFAULT now()
);
CREATE INDEX idx_chargebacks_open ON chargebacks (evidence_due_by) WHERE status IN ('received','arbitration');
CREATE TRIGGER set_chargebacks_updated_at
  BEFORE UPDATE ON chargebacks FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- 4.1.12 reconciliation_runs / discrepancies / locks
CREATE TABLE reconciliation_runs (
  id                   UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  psp_provider         TEXT             NOT NULL,
  run_date             DATE             NOT NULL,
  status               recon_run_status NOT NULL DEFAULT 'running',
  psp_total_kopecks    BIGINT,
  ledger_total_kopecks BIGINT,
  discrepancy_count    INT              NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_recon_terminal ON reconciliation_runs (psp_provider, run_date)
  WHERE status IN ('completed','failed_terminal');

CREATE TABLE reconciliation_discrepancies (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID         NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  psp_reference_id      TEXT         NOT NULL,
  psp_amount_kopecks    BIGINT       NOT NULL,
  ledger_amount_kopecks BIGINT,
  discrepancy_type      TEXT         NOT NULL CHECK (discrepancy_type IN
                          ('amount_mismatch','ledger_missing','psp_missing','status_mismatch')),
  status                recon_status NOT NULL DEFAULT 'open',
  resolved_by_admin_id  UUID         REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_recon_discrepancies_open ON reconciliation_discrepancies (created_at) WHERE status = 'open';

CREATE TABLE reconciliation_locks (
  psp_provider TEXT        NOT NULL,
  run_date     DATE        NOT NULL,
  worker_id    TEXT        NOT NULL,
  locked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (psp_provider, run_date)
);

-- 4.1.13 payment_consumer_cursors (single-active outbox consumer)
CREATE TABLE payment_consumer_cursors (
  consumer_name TEXT        PRIMARY KEY,
  last_seen_id  BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO payment_consumer_cursors (consumer_name) VALUES ('payments_worker') ON CONFLICT DO NOTHING;
```

### 4.2 Outbox Consumer Scan (PAT-002 from Notifications)

```sql
BEGIN;
SELECT last_seen_id FROM payment_consumer_cursors
WHERE consumer_name = 'payments_worker'
FOR UPDATE SKIP LOCKED;
-- 0 rows → COMMIT, sleep 5s, retry.

SELECT id, aggregate_type, event_type, payload, created_at
FROM   outbox_events
WHERE  id > $last_seen_id
  AND  aggregate_type = 'deal'
  AND  event_type IN (
         'deal.escrow_hold_requested','deal.escrow_hold_cancelled',
         'deal.escrow_release_requested','deal.escrow_refund_requested',
         'deal.escrow_partial_release'
       )
ORDER BY id ASC
LIMIT 500;

-- For each event: dispatch via PAY-PAT-003 three-phase sequencing.

UPDATE payment_consumer_cursors
SET last_seen_id = $max_id_in_batch, updated_at = now()
WHERE consumer_name = 'payments_worker';
COMMIT;
```

### 4.3 Three-Phase PSP Charge Sequencing (PAY-PAT-003)

```text
Phase 1 — PSP HTTP call (no DB transaction).
  Request: PaymentProvider.holdFunds(idempotency_key=$key, amount, ...)

Phase 2 — Micro-TX into psp_call_log (BEFORE updating payment_events):
  BEGIN;
  INSERT INTO psp_call_log (payment_event_id, psp_provider, request_idempotency_key,
                            request_method, request_path,
                            response_received_at, response_body_hash, response_metadata)
  VALUES ($pe_id, $psp, $key, 'POST', '/api/3/checkout', now(), $hash, $meta);
  COMMIT;

Phase 3 — Mini-TX UPDATE payment_events:
  BEGIN;
  UPDATE payment_events
  SET status='processing', psp_reference_id=$ref, psp_raw_response=$raw, updated_at=now()
  WHERE id = $pe_id AND status = 'pending';
  COMMIT;

Phase 4 — Main TX (ledger writes + status='succeeded'):
  BEGIN;
  -- ledger entries (PAY-PAT-001 lock ordering, PAY-PAT-002 RETURNING)
  ...
  UPDATE payment_events SET status='succeeded' WHERE id = $pe_id;
  COMMIT;
```

**Recovery rules (REQ-011):**

```sql
-- Phase 4 replay: payment_events stuck at 'processing' with response captured
SELECT id FROM payment_events
WHERE status = 'processing'
  AND psp_raw_response <> '{}'::jsonb
  AND updated_at < now() - INTERVAL '5 minutes';
-- For each: replay ledger writes from psp_raw_response, set status='succeeded'.

-- Orphan PSP charge: psp_call_log with no matching payment_events.psp_reference_id
SELECT pcl.id, pcl.request_idempotency_key
FROM   psp_call_log pcl
LEFT JOIN payment_events pe ON pe.psp_reference_id = pcl.request_idempotency_key
WHERE  pe.id IS NULL
  AND  pcl.response_received_at < now() - INTERVAL '10 minutes';
-- For each: query PSP API, reconstruct payment_events row.
```

### 4.4 Money Flow — Worked Examples

**Single release (agreed_price = 100 UAH = 10000 kopecks; fee = 10%):**

```
HOLD (Client card pre-auth at deal.escrow_hold_requested):
  txn_group_id = G1
  DEBIT  gateway_in_flight    10000  "Client card hold"
  CREDIT escrow_holding       10000  "Escrow funded"
  -- net: gateway_in_flight=+10000, escrow_holding=+10000 → SUM debit/credit balanced.

RELEASE (deal.escrow_release_requested):
  txn_group_id = G2
  -- platform fee (FLOOR(10000 * 1000 / 10000) = 1000):
  DEBIT  escrow_holding        1000  "Platform fee"
  CREDIT platform_fee          1000  "Fee earned"
  -- provider net (10000 - 1000 = 9000):
  DEBIT  escrow_holding        9000  "Provider release"
  CREDIT user_wallet:provider  9000  "Deal D1 release"
  -- gateway settlement:
  DEBIT  gateway_in_flight    10000  "Capture settled"
  CREDIT escrow_holding       10000  "Escrow released to provider"
  -- net: platform_fee=+1000, provider_wallet=+9000, gateway_in_flight=0, escrow_holding=0.
```

**Split release (agreed=99900, release=50100, fee=10%):**

```
fee = FLOOR(50100 * 1000 / 10000) = 5010
provider_net = 50100 - 5010 = 45090
refund = 99900 - 50100 = 49800

txn_group_id = G_split (single group):
  DEBIT  escrow_holding     5010   "Platform fee on split"
  CREDIT platform_fee       5010
  DEBIT  escrow_holding    45090   "Provider partial release"
  CREDIT user_wallet:prov  45090
  DEBIT  escrow_holding    49800   "Client refund"
  CREDIT gateway_in_flight 49800   "Refund settled at PSP"
  DEBIT  gateway_in_flight 50100   "Capture settled (provider portion)"
  CREDIT escrow_holding    50100

Sum check: 45090 + 5010 + 49800 = 99900 ✓
```

**Chargeback flow (R3 fix):**

```
RECEIVED (no ledger entries, metadata-only freeze):
  UPDATE wallet_balances SET frozen_kopecks = frozen_kopecks + $amount
                         WHERE account_id = $provider_wallet;
  -- emit chargeback.received

WON (no ledger entries; just unfreeze):
  UPDATE wallet_balances SET frozen_kopecks = frozen_kopecks - $amount
                         WHERE account_id = $provider_wallet;
  -- emit chargeback.won
  -- IMPORTANT: a later PSP escalation produces a NEW chargebacks row
  --            with a distinct psp_chargeback_id, NOT a state transition.

LOST (real ledger movement):
  txn_group_id = G_cb_lost
  DEBIT  user_wallet:provider  $amount  "Chargeback lost"
  CREDIT chargeback_liability  $amount
  UPDATE wallet_balances SET frozen_kopecks   = frozen_kopecks   - $amount,
                             available_kopecks = available_kopecks - $amount;
  -- emit chargeback.lost

ARBITRATION_REVERSAL_TO_WON (after lost; mirror reversal):
  txn_group_id = G_cb_reverse
  DEBIT  chargeback_liability  $amount  "Arbitration reversal"
  CREDIT user_wallet:provider  $amount
  UPDATE wallet_balances SET available_kopecks = available_kopecks + $amount;
  -- emit chargeback.arbitration_won

SETTLED (PSP pulls funds after lost):
  txn_group_id = G_cb_settle
  DEBIT  chargeback_liability  $amount  "Chargeback settlement"
  CREDIT gateway_in_flight     $amount
  -- emit chargeback.settled
```

### 4.5 Webhook Transactional Inbox (PAY-PAT-004)

```text
Webhook handler (synchronous, returns 200):
  1. Verify PSP signature (constant-time compare). On failure: 401, log only.
  2. BEGIN; INSERT INTO webhook_events (psp_provider, event_id_psp, event_type_psp,
                                        payload, payload_hash, processed)
            VALUES (...) ON CONFLICT (psp_provider, event_id_psp) DO NOTHING; COMMIT.
  3. Return HTTP 200.

Webhook poller (separate process, every 5s):
  BEGIN;
  SELECT id FROM webhook_events
  WHERE processed = false
  ORDER BY received_at ASC
  LIMIT 100
  FOR UPDATE SKIP LOCKED;
  -- For each: process payload, update payment_events, emit outbox events,
  --           SET processed=true, processed_at=now().
  COMMIT;
```

### 4.6 Hold Expiry Monitoring (REQ-021, R4 fix)

```text
Worker scans every 5 minutes:
  SELECT id, deal_id, hold_expires_at
  FROM   payment_events
  WHERE  event_type = 'escrow_hold'
    AND  status = 'succeeded'
    AND  hold_expires_at IS NOT NULL
    AND  hold_expires_at < now() + INTERVAL '24 hours'
    AND  hold_expires_at > now() + INTERVAL '23 hours';
  -- For each: emit payment.hold_expiring (aggregate_type='payment') AND
  --           paired deal.escrow_hold_warning (aggregate_type='deal') in same TX.
  -- The deal.* event is consumed by Notifications via existing allowlist
  -- without waiting for Notifications v1.2.

  -- At -1h:
  SELECT id, deal_id, hold_expires_at
  FROM   payment_events
  WHERE  event_type = 'escrow_hold' AND status = 'succeeded'
    AND  hold_expires_at < now() + INTERVAL '1 hour'
    AND  hold_expires_at > now();
  -- For each: attempt PSP renewal via PaymentProvider.extendHold($psp_reference_id).
  --   On success: update hold_expires_at to renewed value.
  --   On failure: emit payment.hold_expired → Deal consumer triggers
  --               deal.cancelled_hold_expired (Deal v1.2).
```

### 4.7 REST API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/wallet/payout-methods` | provider JWT | Register PSP-tokenized payout method |
| GET | `/api/v1/wallet/payout-methods` | provider JWT | List active methods |
| DELETE | `/api/v1/wallet/payout-methods/{id}` | provider JWT | Soft-delete |
| GET | `/api/v1/wallet/balance` | user JWT | Read available + frozen balance |
| GET | `/api/v1/wallet/ledger` | user JWT | Cursor-paginated ledger entries (id DESC) |
| POST | `/api/v1/payouts` | provider JWT | Request payout (Idempotency-Key header) |
| GET | `/api/v1/payouts/{id}` | provider JWT | Poll payout status |
| POST | `/internal/webhooks/liqpay` | PSP signature | LiqPay webhook receiver |
| POST | `/internal/webhooks/fondy` | PSP signature | Fondy webhook receiver |
| POST | `/internal/webhooks/stripe` | PSP signature | Stripe webhook receiver |
| GET | `/api/v1/admin/reconciliation/runs` | admin | List runs |
| GET | `/api/v1/admin/reconciliation/runs/{id}/discrepancies` | admin | List discrepancies |
| POST | `/api/v1/admin/reconciliation/discrepancies/{id}/resolve` | admin | Manually resolve |
| GET | `/api/v1/admin/payouts` | admin | Filter by status (manual_review by default) |
| POST | `/api/v1/admin/payouts/{id}/approve` | admin | Approve manual-review payout |
| POST | `/api/v1/admin/payouts/{id}/reject` | admin | Reject manual-review payout |
| GET | `/api/v1/admin/chargebacks` | admin | Open chargebacks |
| POST | `/api/v1/admin/chargebacks/{id}/submit-evidence` | admin | Record evidence submission |
| POST | `/api/v1/admin/chargebacks/{id}/resolve` | admin | Record outcome (won/lost/arbitration_won) |

**`POST /api/v1/payouts`** — same-TX KYC gate (REQ-016, PAY-SEC-001):

```json
POST /api/v1/payouts
Authorization: Bearer <jwt>
Idempotency-Key: <uuid>
Content-Type: application/json

{ "payout_method_id": "uuid", "amount_kopecks": 5000000 }

202 Accepted
{ "payout_request_id": "uuid", "status": "queued", "amount_kopecks": 5000000,
  "estimated_arrival": "2026-05-09T18:00:00Z" }

403 { "error": { "code": "account_suspended" } }
422 { "error": { "code": "payout_not_eligible" } }              -- KYC gate failed
422 { "error": { "code": "insufficient_balance",
                 "available_kopecks": 1200000 } }
422 { "error": { "code": "currency_not_supported", "accepted": ["UAH"] } }
409 { "error": { "code": "idempotency_scope_conflict",
                 "existing_provider_id": "uuid" } }
```

### 4.8 Outbox Events Emitted (REQ-026)

| event_type | aggregate_type | When | Payload |
|---|---|---|---|
| `payment.captured` | `payment` | PSP capture confirmed | `{payment_event_id, deal_id, amount_kopecks}` |
| `payment.failed` | `payment` | retries exhausted | `{payment_event_id, deal_id, error_code}` |
| `payment.hold_expiring` | `payment` | -24h before hold expiry | `{payment_event_id, deal_id, hold_expires_at}` |
| `payment.hold_expired` | `payment` | renewal failed at -1h | `{payment_event_id, deal_id}` |
| `deal.escrow_hold_warning` | `deal` | paired with payment.hold_expiring | `{deal_id, client_id, provider_id, hold_expires_at}` |
| `payout.requested` | `payout` | payout queued | `{payout_request_id, provider_id, amount_kopecks}` |
| `payout.completed` | `payout` | PSP confirmed payout | `{payout_request_id, provider_id, amount_kopecks}` |
| `payout.failed` | `payout` | retries exhausted | `{payout_request_id, provider_id, failed_reason}` |
| `refund.issued` | `refund` | PSP refund confirmed | `{payment_event_id, deal_id, amount_kopecks}` |
| `refund.failed` | `refund` | retries exhausted | `{payment_event_id, deal_id, error_code}` |
| `chargeback.received` | `chargeback` | webhook processed | `{chargeback_id, deal_id, amount_kopecks, reason_code}` |
| `chargeback.won` | `chargeback` | dispute outcome | `{chargeback_id, deal_id, amount_kopecks}` |
| `chargeback.lost` | `chargeback` | dispute outcome | `{chargeback_id, deal_id, amount_kopecks}` |
| `chargeback.arbitration_won` | `chargeback` | reversal after lost | `{chargeback_id, deal_id, amount_kopecks}` |
| `chargeback.settled` | `chargeback` | PSP pulled funds | `{chargeback_id, deal_id, amount_kopecks}` |
| `wallet.balance_changed` | `wallet` | any ledger write affecting user_wallet | `{account_id, available_kopecks, change_kopecks, direction}` |

Notifications v1.2 amendment must add `aggregate_type IN ('payment','payout','refund','chargeback','wallet')` and §4.6 catalog rows: `payout_initiated_for_provider`, `payout_completed_for_provider`, `payout_failed_for_provider`, `refund_issued_for_client`, `chargeback_received_for_provider`, `chargeback_lost_for_provider`, `payment_failed_for_client`.

## 5. Acceptance Criteria

- **AC-001** — Given a Provider with `users.status='suspended'`, When `POST /api/v1/payouts`, Then `403 account_suspended` returned via same-TX re-read.
- **AC-002** — Given `kyc_verifications.status IN ('expired','rejected','pending')` OR `provider_profiles.payout_enabled=FALSE`, When payout requested, Then `422 payout_not_eligible`.
- **AC-003** — Given `amount_kopecks > platform_config.payout_manual_review_threshold_kopecks`, When payout requested, Then `payout_request.status='manual_review'`; admin must approve before dispatch.
- **AC-004** — Given concurrent ledger writes producing `SQLSTATE 40P01`, When the writer retries, Then up to 3 attempts with exponential backoff [50, 200, 1000] ms occur; on 4th failure HTTP 500.
- **AC-005** — Given a single release, When the release transaction commits, Then `balance_after_kopecks` for the provider's `user_wallet` row equals the post-update `wallet_balances.available_kopecks` from `UPDATE ... RETURNING`.
- **AC-006** — Given `agreed_price=99900, release_amount=50100, fee_rate_bps=1000`, When split-release executes, Then `provider_net=45090`, `platform_fee=5010`, `refund=49800`, sum 99900, deferred constraint passes.
- **AC-007** — Given `chargebacks.status='lost'`, When the lost transition executes, Then exactly two `ledger_entries` are written for `txn_group=G_cb_lost` (DEBIT `user_wallet`, CREDIT `chargeback_liability`); `frozen` and `available` decrease by the chargeback amount.
- **AC-008** — Given a subsequent `arbitration_won` after `lost`, When the reversal executes, Then `chargeback_liability` is debited and `user_wallet` credited symmetrically; `available` increases.
- **AC-009** — Given `chargebacks.status='won'`, When the win transition executes, Then ZERO ledger entries are written; only `wallet_balances.frozen_kopecks` decreases.
- **AC-010** — Given a phase-1 PSP success followed by phase-2 process death, When the recovery scanner runs after 10 minutes, Then a `psp_call_log` row exists, no matching `payment_events.psp_reference_id`, and the worker reconstructs `payment_events` via PSP API query.
- **AC-011** — Given a duplicate `(psp_provider, event_id_psp)`, When the webhook handler INSERTs, Then `ON CONFLICT DO NOTHING` succeeds and HTTP 200 is returned without re-processing.
- **AC-012** — Given an `idempotency_key` collision on `payment_events` with mismatched `(deal_id, event_type)`, When the request fires, Then `409 idempotency_scope_conflict` returned with the conflicting deal_id.
- **AC-013** — Given a `payment_events.hold_expires_at` 24 hours in the future, When the hold-expiry sweep runs, Then BOTH `payment.hold_expiring` and `deal.escrow_hold_warning` are emitted in the same transaction; the latter is consumed by the Notifications worker without a Notifications v1.2 dependency.
- **AC-014** — Given `agreed_delivery_days > 6` at deal creation, When `POST /deals` fires, Then `422 deal_duration_exceeds_escrow_hold_limit` returned.
- **AC-015** — Given a partial reconciliation failure, When the worker re-runs on the same date, Then a new `reconciliation_runs` row with `status='running'` is inserted; old non-terminal rows are retained as audit; the partial UNIQUE INDEX `uq_recon_terminal` permits this.
- **AC-016** — Given a Provider GDPR erasure request, When the erasure handler runs, Then `payout_methods.display_hint=NULL` and `payout_methods.psp_token=NULL` for the user; `payout_requests.payout_destination_hint` and `payout_destination_bank` are retained for 3 years.
- **AC-017** — Given `MAX(outbox_events.id) - payment_consumer_cursors.last_seen_id > 1000` for 5 consecutive minutes, When Prometheus scrapes, Then the P2 alert fires.
- **AC-018** — Given two Payments worker pods deployed concurrently, When both attempt a scan tick, Then `FOR UPDATE SKIP LOCKED` ensures only one acquires the cursor lock per tick; the other returns 0 rows and idles 5 s.

## 6. Test Automation Strategy

- **Test Levels:** Unit (regex/lock-key derivation, fee math, signature verification per PSP), Integration (PG + Redis ephemeral; concurrent ledger writes; chargeback state machine; PSP-stub webhook flows), End-to-End (full deal lifecycle with mock PSP from creation to release/refund).
- **Frameworks:** project-default backend test stack.
- **Test Data:** seeded `ledger_accounts` for system accounts at fixed UUIDs; `platform_config` seeded with `fee_rate_bps=1000`, `payout_manual_review_threshold_kopecks=10000000`. PSP stubs implement `PaymentProvider` interface deterministically.
- **CI/CD:** integration tests run on every PR. Concurrent-ledger-write test asserts deferred constraint trigger fires for imbalanced txn_groups. Webhook replay tests assert idempotency.
- **Coverage:** ≥90% line coverage on Payments service (financial-grade).
- **Performance:** sustained 100 PSP calls/sec for 30 min via mock PSP; assert p99 phase-1→phase-4 latency < 500 ms; assert reconciliation completes for 100k events/day in <10 min.
- **Concurrency:** two-pod ledger-write deadlock test (asserts canonical lock ordering eliminates 40P01); chargeback arbitration reversal test; phase-2 fail recovery test.
- **Property-based:** invariant tests for `SUM(debit)=SUM(credit)` per `txn_group_id` across all event types and edge prices (1 kopeck, INT64 max).

## 7. Rationale & Context

**Why escrow as PSP pre-auth (hold), not charge:** Charge-then-refund increases dispute rates per Visa/MC Cardholder Disputes Reason Code 4853 ("Credit Not Processed"). Pre-auth keeps funds reserved without settling, making cancellation a void rather than a refund. Trade-off: PSP holds expire (LiqPay 7d, Fondy 7d, Stripe 7d typical), forcing the 6-day deal duration cap.

**Why double-entry ledger with system accounts:** Every money movement is reconstructable from `ledger_entries`. The DEFERRED constraint trigger guarantees no transaction commits with an imbalanced `txn_group_id`. This is non-negotiable for financial-audit compliance under Ukrainian Tax Code Art. 44.3.

**Why R3 chargeback fix (no ledger entries on `won`):** Writing phantom credits on `won` (money never moved) pollutes the ledger. The correct invariant is "ledger entries iff money moved." Won is metadata-only freeze reversal. Post-`won` PSP escalations are NEW chargeback rows (Visa/MC arbitration produces new dispute IDs), so there is no need to track a reversal-of-reversal cycle on the same row.

**Why R4-CF-event-name (two distinct events):** `deal.cancelled_escrow_timeout` is the "PSP never confirmed our hold request" path; `deal.cancelled_hold_expired` is the "PSP confirmed but the hold timed out at PSP side" path. Different deal states, different consumer logic. Conflating them forces consumers to inspect payload metadata, breaking the typed-event contract.

**Why R4-CF-notification-routing (paired event):** Hold expiry warnings are time-sensitive; blocking user delivery on a Notifications v1.2 amendment cycle is unacceptable. Emitting `deal.escrow_hold_warning` (already in the existing aggregate allowlist) gives immediate routing without spec amendment dependency.

**Why three-phase sequencing (PAY-PAT-003):** A single mini-TX leaves a recovery gap if the process dies between PSP HTTP response and DB write. The `psp_call_log` micro-TX captures the PSP response immediately, giving the recovery worker authoritative data even if `payment_events` was never updated.

**Why webhook transactional inbox (PAY-PAT-004):** In-memory queues silently drop on pod crash. A DB-backed queue (`webhook_events.processed=false`) survives crashes; the SKIP LOCKED poller pattern ensures single-active processing across multiple poller pods.

**Why FLOOR + provider-net residual rounding:** FLOOR on the fee guarantees the platform never charges more than 10%; provider net is the exact residual, so the ledger always sums to `agreed_price`. Computing fee from `release_amount` (not `agreed_price`) on splits is critical — the original buggy formula produced 1-kopeck imbalances on odd prices.

**Why PSP-tokenized only (PCI SAQ-A):** Storing PAN/CVV puts the platform into PCI-DSS SAQ-D scope, requiring quarterly ASV scans, annual ROC, and full segmentation audit. SAQ-A scope (full PSP delegation) is achievable for a marketplace at 1/10th the compliance cost.

**Why 7y ledger / 3y operational PII:** Ukrainian Tax Code Art. 44.3 requires 1095 days (≈3 years) for primary financial documents; ZU "Про бухгалтерський облік та фінансову звітність" Art. 44 confirms 3 years. Ledger entries are kept 7 years for safety margin against audit re-extension. Operational PII (bank hints) is sweeped to NULL after 3 years to minimize breach surface while preserving ledger integrity.

**Why dual-source KYC gate (REQ-016):** Provider `provider_profiles.kyc_status` is a denormalized copy. If the KYC expiry sweep partially fails after writing `kyc_verifications` but before `provider_profiles`, the denormalized column stays `approved` — payouts could leak to an expired-KYC provider. Joining both tables under `FOR SHARE` is defense-in-depth.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** — LiqPay (Privatbank) — UAH escrow + payout. SLA 99.5%. Webhook signature SHA-1 HMAC.
- **EXT-002** — Fondy (Tipalti owned) — secondary fallback. Webhook signature SHA-256 HMAC.
- **EXT-003** — Stripe Connect — stub at MVP; production pending UA legal entity registration.

### Third-Party Services
- **SVC-001** — PSP webhook delivery — must accept HTTP 200 within 30s; PSP retries on non-200.
- **SVC-002** — PSP statement API — daily settlement reports for reconciliation.

### Infrastructure Dependencies
- **INF-001** — PostgreSQL 15+ shared cluster.
- **INF-002** — Redis 7+ for rate limiting.
- **INF-003** — Secrets manager (Vault/AWS Secrets) for PSP signing keys.

### Data Dependencies
- **DAT-001** — `outbox_events` (Category Tree §4.3) — primary input.
- **DAT-002** — `users`, `provider_profiles`, `kyc_verifications` for payout gating.
- **DAT-003** — `deals` for FK + escrow lifecycle correlation.

### Technology Platform Dependencies
- **PLT-001** — PostgreSQL ≥ 11 for `hashtextextended` (used in advisory locks if added later).
- **PLT-002** — `pg_cron` or platform scheduler for retention sweeps and reconciliation runs.

### Compliance Dependencies
- **COM-001** — Ukrainian Tax Code Art. 44.3 (1095 days financial-record retention).
- **COM-002** — ЗУ "Про бухгалтерський облік та фінансову звітність" Art. 44 (3-year primary document retention).
- **COM-003** — ЗУ "Про запобігання та протидію легалізації доходів" — AML thresholds inform manual-review threshold (REQ-017).
- **COM-004** — PCI-DSS SAQ-A — PSP-tokenized card data only; no PAN in platform environment.
- **COM-005** — GDPR Art. 6(1)(c) (legal obligation) for retention-window personal data; Art. 17(3)(b) (financial record exception) for ledger 7y retention.

## 9. Examples & Edge Cases

### 9.1 Payout dispatch happy path

```json
POST /api/v1/payouts
Idempotency-Key: 11111111-1111-1111-1111-111111111111
{ "payout_method_id": "uuid", "amount_kopecks": 5000000 }

202 Accepted
{ "payout_request_id": "uuid", "status": "queued", "amount_kopecks": 5000000 }
```

### 9.2 Phase-2 failure recovery

Process dies between PSP HTTP 200 (Phase 1) and `psp_call_log` INSERT (Phase 2). On retry with the same `idempotency_key`, the PSP returns the original result; Phase 2 proceeds with the same `request_idempotency_key` and the `UNIQUE` constraint deduplicates if Phase 2 had already partially run.

### 9.3 Edge case — split with 1-kopeck release

`agreed=999, release=1, fee_rate_bps=1000`:
- `fee = FLOOR(1 * 1000 / 10000) = 0`
- `provider_net = 1 - 0 = 1`
- `refund = 999 - 1 = 998`
- Sum: `1 + 0 + 998 = 999` ✓

Platform earns zero fee on this split — accepted product edge case (admin micro-split). A future enhancement may add a minimum-fee floor.

### 9.4 Edge case — chargeback after admin manual release

Provider receives a manual release via admin tooling (deal stuck in dispute, admin resolves in provider's favor). PSP later issues a chargeback (Client filed with bank). The `chargebacks.received` handler freezes the provider's wallet balance; if `frozen_kopecks > available_kopecks`, the row may be impossible to satisfy from balance alone — admin queue surfaces this for manual reconciliation.

### 9.5 Edge case — Redis flush during webhook poller

Redis is unused in the webhook path (transactional inbox lives entirely in PG). A Redis flush has no effect on webhook delivery semantics. Wallet-balance Redis caches (if added) are best-effort; PG is authoritative.

## 10. Validation Criteria

A compliant implementation MUST:

1. Pass AC-001 through AC-018 in CI.
2. Fail the build/deploy if Deal v1.2 or Notifications v1.2 amendments are absent (deploy-time enum/allowlist check).
3. Reject any code path that mutates `outbox_events.status` from the Payments service.
4. Reject any code path that issues a PSP charge without first writing `psp_call_log` in a micro-TX after the HTTP response.
5. Reject any code path that bypasses the same-TX KYC gate on payout dispatch.
6. Reject any code path that stores raw PAN, CVV, or full IBAN in any DB column or log line.
7. Verify the deferred constraint trigger on `ledger_entries` rejects imbalanced `txn_group_id` at COMMIT time via integration test.
8. Verify webhook signature verification with constant-time compare via security-test fixture (timing-attack resistant).
9. Provide chargeback-state-machine integration tests covering: received→won, received→lost→arbitration_won→settled, received→lost→settled, plus the post-won PSP escalation case (new `chargebacks` row).
10. Reject any code path that DELETEs from `payout_requests` for retention purposes — retention is NULL-on-expiry only.

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — escrow events §4.8.1; **REQUIRES v1.2 amendment** (CON-001) to add `deal.cancelled_hold_expired` and `deal.escrow_hold_warning`.
- [`spec/spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — REQ-010 dual-source KYC gate; `kyc_verifications` schema.
- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `users`, `provider_profiles`, MSG-SEC-001 same-TX pattern (mirrored as PAY-SEC-001).
- [`spec/spec-architecture-notifications.md`](./spec-architecture-notifications.md) — **REQUIRES v1.2 amendment** (CON-002) to extend allowlist with payment/payout/refund/chargeback/wallet aggregate types and add 7 catalog rows.
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — `outbox_events` DDL §4.3.
- [`spec/spec-architecture-messaging.md`](./spec-architecture-messaging.md) — admin queue overlap for chargeback review.
- LiqPay API docs (RECEIPTS, holds, payouts) — referenced in code comments at integration boundary.
- PCI-DSS SAQ-A Validation Requirements v4.0.
- ЗУ "Про бухгалтерський облік та фінансову звітність в Україні" Art. 44.
- Ukrainian Tax Code Art. 44.3.
