---
title: KYC — Provider Verification (SEC-004)
version: 1.0
date_created: 2026-05-06
last_updated: 2026-05-06
owner: Platform / Trust & Safety Team
tags: [architecture, kyc, compliance, payout, provider, security]
---

# Introduction

This specification defines the KYC (Know Your Customer) module for Provider verification on the Robotun freelance marketplace. KYC is **required before Provider payout**, NOT before deal creation. Verification is performed by manual admin review of submitted Ukrainian identity documents (паспорт, ID-картка, РНОКПП, селфі). On approval, the Provider's `payout_enabled` flag is atomically flipped to `true` (subject to MFA enrollment per Auth spec REQ-005), unblocking escrow release events emitted by the Deal Workflow module.

The spec is the synthesis of an `architect` × `critic` orchestration loop: 23 final DECISIONs across 3 architect rounds and 2 critic rounds, with all 26 flagged risks resolved or formally accepted as residual.

## 1. Purpose & Scope

**In scope**

- KYC verification state machine: `not_submitted → submitted → in_review → approved | rejected | expired | cancelled`.
- Document schema (`kyc_verifications`, `kyc_documents`, `kyc_review_events`, partitioned).
- REST API: provider self-service (submit/resubmit/view), admin queue and review (claim/approve/reject/suspend/unblock/flag-rekyc), document streaming proxy.
- Two-phase upload pattern with quarantine prefix.
- App-layer AES-256-GCM PII encryption with KMS-managed envelope and encryption-context binding.
- Cross-table payout enablement contract: dual triggers + reconciliation alert + same-DB single-tx mutations + enum mapping.
- Document expiry / re-KYC sweep timers.
- Ukrainian document identifier validation (RNOKPP checksum, passport/ID-card formats).
- Retention windows under ЦК України ст. 257 (3-year civil-law statute of limitations).
- ON DELETE behavior compatible with Auth-spec 90-day hard-purge.

**Out of scope**

- **Diia.ID, OCR, automated face-match, liveness video** — manual admin review only at MVP; deferred to v2. Schema reserves `automated_check_result JSONB` future column.
- **Sanctions screening (РНБО / EU / OFAC)** — explicitly deferred to v2. The retention rationale in this spec is civil-law-grounded, NOT AML-grounded; sanctions screening is decoupled.
- **Four-eyes review** for high-value KYC (schema-compatible via future `approved_by_second_admin_id`).
- **Senior-admin escalation endpoint** for `submission_limit > 20` — separate process module.
- **AML transaction monitoring**.
- **FOP business-registry validation** (`fop_certificate` accepted but not cross-checked at MVP).
- **Client-side KYC** (only Provider-side per established project decision).
- **Country-specific document formats beyond Ukrainian-context regex** for foreign passports.
- **Notification delivery** — KYC emits outbox events; the Notifications module owns delivery.
- **Admin UI / queue management tooling** — API contract only.
- **KMS degraded-mode runbook content** — operational runbook, not spec.

**Audience:** backend engineers, platform/data engineers, security/compliance reviewers, QA, AI code-generation agents producing DDL and service code.

## 2. Definitions

| Term | Definition |
|------|------------|
| KYC | Know Your Customer — identity verification of a Provider before payout eligibility. |
| Provider | A user with the `provider` role who can be a counterparty on deals (per Module 1). |
| Payout | A transfer of escrow funds from the platform's Payments module to a Provider's external account. The platform does NOT process payments at MVP (umbrella CON-002); payout is an interface contract. |
| RNOKPP / ІПН | Реєстраційний номер облікової картки платника податків — Ukrainian taxpayer registration number. 10 digits with checksum. |
| ID-card (новий зразок) | Біометрична ID-картка громадянина України. 9-digit identifier. |
| Паспорт-книжечка | Passport book of the older format. Identifier: 2 Cyrillic letters + 6 digits. |
| ФОП | Фізична особа-підприємець — Ukrainian sole proprietor. Optional document for business-account payouts. |
| Selfie | Photo of the Provider holding the identity document, used as a manual liveness anchor. |
| KEK | Key Encryption Key — the KMS-managed CMK that wraps per-record DEKs. |
| DEK | Data Encryption Key — short-lived symmetric key used to encrypt PII columns. |
| Encryption context | AWS Encryption SDK construct binding metadata (kek_version, document_id, provider_id) into AAD; mismatch causes auth-tag failure on decrypt. |
| SEC-006 | Auth-spec requirement: high-impact mutations re-read the actor's role from primary DB rather than trusting JWT claims alone. |
| INF-003 | Auth-spec key-management infrastructure (RS256 + KMS) reused for KYC envelope encryption. |
| ЦК України ст. 257 | Civil Code of Ukraine, Article 257 — 3-year general limitation period for contractual disputes. Cited as legal basis for retention. |
| ЗУ Про захист персональних даних | Ukrainian Personal Data Protection Law — governs PII handling, retention proportionality, right-to-erasure. |
| Submission index | An integer that increments with each provider resubmission; `kyc_documents` rows tagged with this index for history scoping. |
| KYC-PII KMS key | Dedicated CMK in the same AWS account/region as the KYC bucket, separate from the media KMS key. |

## 3. Requirements, Constraints & Guidelines

### Functional Requirements

- **REQ-001**: The system SHALL persist each Provider's current KYC state as a single row in `kyc_verifications` (UNIQUE on `provider_id`).
- **REQ-002**: The system SHALL record full submission history in `kyc_documents` via `submission_index` (incremented on each resubmit).
- **REQ-003**: A Provider SHALL submit/resubmit KYC via `POST /kyc/me/submissions`. Submission MUST include the minimum required document set: ONE of {`passport_ua`, `id_card`, `passport_foreign`} + `rnokpp` + `selfie`. Optional: `fop_certificate`.
- **REQ-004**: The system SHALL validate document identifiers server-side at submission time per §4.4 (RNOKPP checksum, ID-card/passport regex). Validation failure returns 422 with field-level error codes.
- **REQ-005**: The system SHALL implement a two-phase upload: `POST /kyc/me/uploads/initiate` returns a presigned PUT URL to a quarantine prefix; `POST /kyc/me/uploads/confirm` issues a blocking HEAD against the object store then server-side-copies to the permanent prefix. Quarantine objects SHALL auto-delete after 2 hours.
- **REQ-006**: An Admin SHALL claim a submission via `POST /admin/kyc/{provider_id}/claim` (transitions `submitted → in_review`, sets `reviewed_by`). Stale claims (`in_review` for >4h) SHALL be auto-evicted by a sweep.
- **REQ-007**: An Admin SHALL approve via `POST /admin/kyc/{provider_id}/approve` or reject via `POST /admin/kyc/{provider_id}/reject` with mandatory `rejection_code` (enum) + optional `rejection_note`.
- **REQ-008**: KYC approval SHALL atomically (single DB transaction) update `kyc_verifications.status='approved'`, update `provider_profiles.kyc_status='approved'` AND `payout_enabled=mfa_enabled` (per cross-table contract §4.7), and emit `kyc.approved` to outbox.
- **REQ-009**: The system SHALL run a daily expiry sweep that flags KYC records 30 days before `expires_at` (`kyc.rekyc_required` event) and auto-expires at `expires_at <= now()` (transitions to `expired`, sets `payout_enabled=false`).
- **REQ-010**: The Payments module SHALL gate every payout on a defense-in-depth read joining `provider_profiles` + `kyc_verifications` (§4.7).
- **REQ-011**: An Admin SHALL force re-KYC via `POST /admin/kyc/{provider_id}/flag-rekyc` (immediately sets `payout_enabled=false` + emits `kyc.rekyc_required` with reason).
- **REQ-012**: The system SHALL enforce a 24-hour cooling-off between rejection and resubmit (429 `resubmit_too_soon`) AND a lifetime `submission_limit` (default 5; admin `/unblock` increments by 5; absolute ceiling 20).
- **REQ-013**: All document access (provider OR admin) SHALL be served via app-tier streaming proxy (`GET /kyc/me/documents/{id}/stream`, `GET /admin/kyc/{provider_id}/documents/{id}/stream`). No signed URLs are returned to clients.
- **REQ-014**: Every state-mutating admin action SHALL append a row to `kyc_review_events` in the same transaction, capturing IP, UA, actor, and event-specific metadata.
- **REQ-015**: Account soft-delete SHALL NOT be blocked by an open KYC review. KYC transitions to `cancelled` terminal state; restoration within 90 days returns to `not_submitted`.

### Security Requirements

- **SEC-001**: Every admin KYC mutation (claim, approve, reject, suspend, unblock, flag-rekyc) SHALL execute the SEC-006 admin-role re-read against `user_roles` JOIN `users` before any state change. JWT-claim-only acceptance is non-conformant.
- **SEC-002**: PII fields (`document_number_enc`, `full_name_enc`, `date_of_birth_enc`) SHALL be stored as ciphertext produced by AWS Encryption SDK (AES-256-GCM, KMS-managed envelope). Plaintext SHALL NOT be written to the DB. Plaintext SHALL NOT be logged.
- **SEC-003**: Encryption SHALL bind `{kek_version, document_id, provider_id}` in the AWS Encryption SDK encryption context (AAD). Decrypt SHALL fail with auth-tag mismatch on context divergence.
- **SEC-004**: The KYC bucket SHALL be private (no public access), SSE-KMS-encrypted with a **dedicated CMK** (separate from media). Cross-region replication SHALL be DISABLED. Versioning SHALL be ENABLED.
- **SEC-005**: KYC service IAM role on the dedicated CMK SHALL include `kms:Decrypt` and `kms:GenerateDataKey` only. `kms:ScheduleKeyDeletion`, `kms:DisableKey`, `kms:DeleteImportedKeyMaterial` SHALL NOT be granted.
- **SEC-006**: `kyc_review_events` SHALL be append-only, enforced by DB GRANT (only INSERT, SELECT — no UPDATE, no DELETE granted to application role). IP and user_agent SHALL be captured on every event row and SHALL NEVER be returned to provider-facing endpoints.
- **SEC-007**: The dual triggers (§4.6) SHALL enforce `payout_enabled=true ⟺ kyc_status='approved' AND mfa_enabled=true` at DB level. Direct DB writes that violate this invariant SHALL be rejected with `P0001`.
- **SEC-008**: File keys SHALL be UUID v4 (random). Sequential UUIDs (v1, v7) SHALL NOT be used.
- **SEC-009**: Bucket access logs SHALL be classified as PII; retention 1 year; access restricted to a separate security/compliance IAM role.
- **SEC-010**: Per-admin concurrent claim count SHALL NOT exceed 10. The 11th claim SHALL return 429 `claim_limit_exceeded`.

### Constraints

- **CON-001**: Manual admin review only. No automated OCR, face-match, liveness, or third-party KYC vendor integration at MVP.
- **CON-002**: Single PostgreSQL instance hosts `kyc_verifications`, `kyc_documents`, `kyc_review_events`, `provider_profiles`, `users`. Cross-database transactions are not used. KYC state mutations are single-DB-tx.
- **CON-003**: AML compliance is NOT claimed as legal basis for retention. The legal basis is ЦК України ст. 257 (3-year civil statute of limitations) plus legitimate interest in defending platform-dispute claims.
- **CON-004**: Sanctions screening (РНБО / EU / OFAC) is NOT performed at MVP. Until implemented, the platform MUST NOT advertise or assert AML compliance. Disclosure in Privacy Policy follows the civil-law rationale.
- **CON-005**: All timestamps are `TIMESTAMPTZ`. Document expiry stored as `DATE` (calendar-day granularity).
- **CON-006**: Money is not stored in this module. Payout amounts live in the Payments module.
- **CON-007**: KYC admin API uses Bearer JWT auth; internal admin endpoints additionally require SEC-006 re-read. There is no internal service-account endpoint in the KYC module (Payments reads `provider_profiles.payout_enabled` directly).
- **CON-008**: The minimum required document set is non-negotiable for approval. Partial approval is NOT supported (binary decision per KYC-16).
- **CON-009**: Maximum file size per document upload: 20 MB. Allowed MIME types: `image/jpeg`, `image/png`, `application/pdf`.
- **CON-010**: `submission_limit` absolute ceiling = 20. Beyond 20 requires senior-admin escalation (out of scope for this spec).

### Guidelines

- **GUD-001**: Operational runbook SHOULD be updated to handle KMS-degraded mode (read-only admin queue via feature flag `kyc_kms_degraded`).
- **GUD-002**: KYC retention windows and legal basis SHOULD be reviewed annually by qualified Ukrainian privacy counsel; deviations from the assumed civil-law basis MUST trigger a spec revision.
- **GUD-003**: Implementations SHOULD use AWS Encryption SDK data-key caching (5min TTL / 1000 bytes / 100 messages per cached key) to reduce KMS request rate during admin-queue bursts.
- **GUD-004**: Streaming proxy SHOULD be deployable as a separate process/container when sustained `kyc_document_stream_concurrent_count > 20` — alert level P3 (scale-out trigger, not human action).

### Patterns

- **PAT-001**: SEC-006 admin re-read pattern (reused from Auth spec) on every admin mutation.
- **PAT-002**: Dual-trigger DB-level invariant — when an invariant spans tables, enforce it from BOTH sides via BEFORE UPDATE/INSERT triggers, plus a redundant CHECK on the primary side.
- **PAT-003**: Atomic per-row encryption migration — when KEK rotates, UPDATE all encrypted columns + version column in a single statement; readers use MVCC snapshot consistency to avoid split states.
- **PAT-004**: Quarantine-then-promote upload — pre-confirm objects live in a TTL-deletable quarantine prefix; confirm handler validates existence (HEAD) then server-side-copies to permanent prefix.
- **PAT-005**: Bidirectional reconciliation query — for cross-table denormalized invariants, monitor BOTH drift directions; financially-exposed direction triggers automatic remediation.

## 4. Interfaces & Data Contracts

### 4.1 Schema — `kyc_verifications`

```sql
CREATE TABLE kyc_verifications (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id              UUID         REFERENCES users(id) ON DELETE SET NULL,  -- NULLABLE for hard-purge

  status                   TEXT         NOT NULL DEFAULT 'not_submitted'
                             CHECK (status IN (
                               'not_submitted','submitted','in_review',
                               'approved','rejected','expired','cancelled'
                             )),

  -- Lifecycle timestamps
  submitted_at             TIMESTAMPTZ,
  review_started_at        TIMESTAMPTZ,
  decided_at               TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,

  -- Rejection
  rejection_code           TEXT
                             CHECK (rejection_code IN (
                               'document_expired','document_unreadable','document_mismatch',
                               'selfie_mismatch','data_inconsistency','unsupported_document_type',
                               'incomplete_submission','fraud_suspicion','other'
                             )),
  rejection_note           TEXT,

  -- Re-verification trigger
  rekyc_required_reason    TEXT
                             CHECK (rekyc_required_reason IN (
                               'document_expiry','periodic_rekyc','suspicious_activity',
                               'admin_manual','account_deleted'
                             )),
  rekyc_required_at        TIMESTAMPTZ,

  -- Reviewer (claim)
  reviewed_by              UUID         REFERENCES users(id) ON DELETE SET NULL,

  -- Submission tracking
  submission_count         INT          NOT NULL DEFAULT 0,
  submission_limit         INT          NOT NULL DEFAULT 5,
  last_decided_at          TIMESTAMPTZ,

  -- Concurrency
  version                  INT          NOT NULL DEFAULT 1,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_kyc_provider UNIQUE (provider_id),
  CONSTRAINT chk_decided_at  CHECK (status NOT IN ('approved','rejected','expired') OR decided_at IS NOT NULL),
  CONSTRAINT chk_submitted_at CHECK (status = 'not_submitted' OR submitted_at IS NOT NULL),
  CONSTRAINT chk_rejection_fields CHECK (status = 'rejected' OR (rejection_code IS NULL AND rejection_note IS NULL)),
  CONSTRAINT chk_submission_limit CHECK (submission_limit BETWEEN 5 AND 20)
);

CREATE INDEX idx_kyc_status_queue ON kyc_verifications (created_at)
  WHERE status = 'submitted' AND reviewed_by IS NULL;
CREATE INDEX idx_kyc_in_review ON kyc_verifications (review_started_at)
  WHERE status = 'in_review';
CREATE INDEX idx_kyc_expires ON kyc_verifications (expires_at)
  WHERE status = 'approved' AND expires_at IS NOT NULL;
CREATE INDEX idx_kyc_rekyc_due ON kyc_verifications (rekyc_required_at)
  WHERE rekyc_required_at IS NOT NULL AND status = 'approved';

CREATE TRIGGER set_kyc_updated_at
  BEFORE UPDATE ON kyc_verifications
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
```

### 4.2 Schema — `kyc_documents`

```sql
CREATE TABLE kyc_documents (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_verification_id   UUID         NOT NULL REFERENCES kyc_verifications(id) ON DELETE RESTRICT,
  provider_id           UUID         REFERENCES users(id) ON DELETE SET NULL,

  document_type         TEXT         NOT NULL
                          CHECK (document_type IN (
                            'passport_ua','passport_foreign','id_card',
                            'rnokpp','fop_certificate','selfie'
                          )),

  -- Storage (UUID v4 file key, no PII in path)
  file_key              TEXT,                         -- nullable to support purge
  file_name             TEXT         NOT NULL,
  mime_type             TEXT         NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','application/pdf')),
  size_bytes            BIGINT       NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),

  -- Encrypted PII (AES-256-GCM via AWS Encryption SDK; encryption context bound)
  document_number_enc   BYTEA,
  full_name_enc         BYTEA,
  date_of_birth_enc     BYTEA,
  kek_version           TEXT         NOT NULL DEFAULT 'v1',  -- KMS key version identifier

  -- Plaintext (non-PII)
  document_expires_at   DATE,                          -- NULL for non-expiring docs (rnokpp)

  -- Per-document review
  verification_status   TEXT         NOT NULL DEFAULT 'pending'
                          CHECK (verification_status IN ('pending','accepted','rejected')),
  rejection_reason      TEXT,                          -- admin-visible only

  -- Submission scoping
  submission_index      INT          NOT NULL,

  uploaded_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reviewed_at           TIMESTAMPTZ,

  CONSTRAINT chk_doc_reviewed_at CHECK (verification_status = 'pending' OR reviewed_at IS NOT NULL)
);

CREATE INDEX idx_kyc_docs_verification ON kyc_documents (kyc_verification_id, submission_index);
CREATE INDEX idx_kyc_docs_provider     ON kyc_documents (provider_id, uploaded_at);
CREATE INDEX idx_kyc_docs_expiry       ON kyc_documents (document_expires_at)
  WHERE document_expires_at IS NOT NULL AND verification_status = 'accepted';
CREATE INDEX idx_kyc_docs_kek_rotation ON kyc_documents (kek_version);
```

### 4.3 Schema — `kyc_review_events` (partitioned, append-only)

```sql
CREATE TABLE kyc_review_events (
  id                  BIGSERIAL,
  kyc_verification_id UUID         NOT NULL,
  provider_id         UUID,                            -- opaque, NO FK (preserved on user purge)
  actor_id            UUID         REFERENCES users(id) ON DELETE SET NULL,
  actor_role          TEXT         NOT NULL CHECK (actor_role IN ('provider','admin','senior_admin','system')),
  event_type          TEXT         NOT NULL,
  from_status         TEXT,
  to_status           TEXT,
  metadata            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ip                  INET,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partitions created by same maintenance job as audit_events (Auth spec).
CREATE INDEX idx_kyc_events_kv      ON kyc_review_events (kyc_verification_id, created_at DESC);
CREATE INDEX idx_kyc_events_provider ON kyc_review_events (provider_id, created_at DESC) WHERE provider_id IS NOT NULL;
CREATE INDEX idx_kyc_events_admin   ON kyc_review_events (actor_id, created_at DESC) WHERE actor_role IN ('admin','senior_admin');

-- Append-only enforcement via DB privileges:
-- GRANT INSERT, SELECT ON kyc_review_events TO kyc_service;
-- (NO UPDATE, NO DELETE granted)
```

### 4.4 Document identifier validation

Validated server-side at `POST /kyc/me/submissions` BEFORE any DB insert. 422 with field-level error codes.

#### 4.4.1 RNOKPP (10-digit + checksum)

Weights `w[i]` for positions 1–9 (1-based): `[-1, 5, 7, 9, 4, 6, 10, 5, 7]`.

```
sum   = Σ (digit[i] * w[i])  for i in 1..9
check = ((sum mod 11) + 11) mod 11   -- Euclidean modulo (mandatory)
check = check mod 10
check MUST equal digit[10]
```

**Mandatory implementation note:** Use Euclidean modulo for `sum mod 11` — `((sum % 11) + 11) % 11` — to ensure portability across truncated-division languages (C, Go, Java, JS, Python 2). Without it, ~1-in-11 valid RNOKPPs are wrongly rejected.

**Worked example — RNOKPP `3068217500`:**

| pos | digit | weight | product |
|----|-----|------|--------|
| 1 | 3 | -1 |   -3 |
| 2 | 0 |  5 |    0 |
| 3 | 6 |  7 |   42 |
| 4 | 8 |  9 |   72 |
| 5 | 2 |  4 |    8 |
| 6 | 1 |  6 |    6 |
| 7 | 7 | 10 |   70 |
| 8 | 5 |  5 |   25 |
| 9 | 0 |  7 |    0 |

`sum = 220`. `((220 % 11) + 11) % 11 = 0`. `0 % 10 = 0`. Check digit = 0 ✓.

#### 4.4.2 Other identifier formats

| Document | Regex | Error code |
|----------|-------|-----------|
| ID-card (новий зразок) | `^\d{9}$` | `invalid_id_card_format` |
| Passport-book (старий зразок) | `^[А-ЯІЇЄ]{2}\d{6}$` (excludes Ё, not Ukrainian) | `invalid_passport_ua_format` |
| Foreign passport | `^[A-Z0-9]{6,9}$` | `invalid_passport_foreign_format` |
| RNOKPP format | `^\d{10}$` | `invalid_rnokpp_format` |
| RNOKPP checksum | (algorithm above) | `invalid_rnokpp_checksum` |

### 4.5 State machine

```
                     (DB trigger or auth-svc call on provider role grant)
                                       │
                                       ▼
                              ┌────────────────┐
                              │  not_submitted │
                              └────────┬───────┘
                  (provider POST /kyc/me/submissions)
                                       ▼
                              ┌────────────────┐
                  ┌───────────│   submitted    │◄──────────────┐
                  │           └────────┬───────┘               │
                  │   (admin /claim)            (resubmit from │
                  │   ──> sets reviewed_by      rejected/expired
                  │      version++              after 24h cooling-off)
                  ▼                                            │
            ┌──────────────┐                                   │
            │  in_review   │                                   │
            └──────┬───────┘                                   │
   ┌──────────────┼──────────────────┐                         │
   │ (admin /approve)   (admin /reject)  (4h stale-claim eviction)
   ▼              ▼              ▼                             │
┌──────────┐  ┌──────────┐  back to submitted                  │
│ approved │  │ rejected │──────────────────────────────────┐  │
└────┬─────┘  └──────┬───┘                                  │  │
     │ (expiry sweep)│ (expiry sweep on inactive approved) │  │
     ▼               │                                      │  │
┌──────────┐         │                                      └──┘
│ expired  │─────────┘
└──────────┘
                          (account soft-delete mid-review)
                                       │
                                       ▼
                              ┌──────────────┐
                              │  cancelled   │  (terminal; restore within 90d → not_submitted)
                              └──────────────┘
```

Transition guards:

| From | To | Actor | Guard | Side-effects |
|------|------|------|-------|---------------|
| (none) | not_submitted | system | provider role grant | Insert row |
| not_submitted | submitted | provider | POST /kyc/me/submissions, valid docs, format-validated | submitted_at=now(), submission_count++, outbox kyc.submitted |
| submitted | in_review | admin | claim, SEC-006 OK, claim count <10 | reviewed_by=admin, review_started_at=now(), version++ |
| in_review | approved | admin | SEC-006 OK, single-tx update kyc + provider_profiles + outbox | decided_at=now(), expires_at=MIN(scoped doc expiry), payout_enabled=mfa_enabled, outbox kyc.approved |
| in_review | rejected | admin | SEC-006 OK, rejection_code required | decided_at=now(), rejection fields, outbox kyc.rejected |
| approved | rejected (suspend) | admin | SEC-006 OK | payout_enabled=false, outbox kyc.suspended |
| approved | expired | system | expires_at <= now() | payout_enabled=false, outbox kyc.expired |
| rejected/expired | submitted | provider | last_decided_at <= now()-24h, submission_count < submission_limit | clears reviewed_by, version++ |
| any non-terminal | cancelled | system | account soft-delete | rekyc_required_reason='account_deleted' |
| in_review | submitted | system | review_started_at <= now()-4h | clears reviewed_by, review_started_at, version++ |

### 4.6 Cross-table payout enablement (dual triggers + reconciliation)

#### 4.6.1 Trigger A — `provider_profiles` BEFORE INSERT/UPDATE

Prevents `payout_enabled=true` when `users.mfa_enabled=false`.

```sql
CREATE OR REPLACE FUNCTION fn_provider_profiles_payout_mfa_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payout_enabled THEN
    IF NOT (SELECT mfa_enabled FROM users WHERE id = NEW.user_id) THEN
      RAISE EXCEPTION 'payout_enabled cannot be true when mfa_enabled is false'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_provider_profiles_payout_mfa
  BEFORE INSERT OR UPDATE ON provider_profiles
  FOR EACH ROW EXECUTE FUNCTION fn_provider_profiles_payout_mfa_check();
```

#### 4.6.2 Trigger B — `users` BEFORE UPDATE OF mfa_enabled

**Comment is normative:** `Guard: preventing mfa_enabled true→false while payout_enabled=true.`

```sql
CREATE OR REPLACE FUNCTION fn_users_mfa_payout_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Guard: preventing mfa_enabled true→false while payout_enabled=true.
  -- Rationale: payout_enabled requires MFA; disabling MFA must first revoke
  -- payout via the KYC suspension path. Reverse order is rejected here.
  IF OLD.mfa_enabled = TRUE AND NEW.mfa_enabled = FALSE THEN
    IF EXISTS (
      SELECT 1 FROM provider_profiles
      WHERE user_id = NEW.id AND payout_enabled = TRUE
    ) THEN
      RAISE EXCEPTION 'cannot_disable_mfa_while_payout_enabled'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_mfa_payout_check
  BEFORE UPDATE OF mfa_enabled ON users
  FOR EACH ROW EXECUTE FUNCTION fn_users_mfa_payout_check();
```

#### 4.6.3 Enum mapping (kyc_verifications.status → provider_profiles.kyc_status)

| kyc_verifications.status | provider_profiles.kyc_status |
|---|---|
| not_submitted | none |
| cancelled | none |
| submitted | pending |
| in_review | pending |
| approved | approved |
| rejected | rejected |
| expired | rejected |

#### 4.6.4 Bidirectional reconciliation query

Runs every 5 minutes. P2 PagerDuty alert on any returned row.

```sql
-- Direction A: alert only (operational delay, no financial exposure)
SELECT kv.provider_id, 'approved_payout_disabled' AS drift_type
FROM kyc_verifications kv
JOIN provider_profiles pp ON pp.user_id = kv.provider_id
JOIN users u ON u.id = kv.provider_id
WHERE kv.status = 'approved'
  AND pp.payout_enabled = FALSE
  AND u.mfa_enabled = TRUE
  AND kv.decided_at < now() - interval '5 minutes'

UNION ALL

-- Direction B: alert + automatic remediation (financial exposure)
SELECT kv.provider_id, 'revoked_payout_still_enabled' AS drift_type
FROM kyc_verifications kv
JOIN provider_profiles pp ON pp.user_id = kv.provider_id
WHERE kv.status IN ('rejected','expired','cancelled')
  AND pp.payout_enabled = TRUE;
```

**Direction B auto-remediation:** the reconciliation job MUST issue `UPDATE provider_profiles SET payout_enabled=FALSE WHERE user_id=$1` and INSERT a `kyc_review_events` row with `event_type='reconciliation_auto_correction'` and `metadata={"drift_type":"revoked_payout_still_enabled"}`.

**Direction A:** alert only — no auto re-enable (avoids enabling payout during partially-applied state).

### 4.7 Payments-side payout gate (defense-in-depth)

The Payments module SHALL execute this read against the primary DB (not replica, not cache) before initiating any payout:

```sql
SELECT 1
FROM provider_profiles pp
JOIN kyc_verifications kv ON kv.provider_id = pp.user_id
WHERE pp.user_id = $provider_id
  AND pp.payout_enabled = TRUE
  AND kv.status = 'approved'
  AND (kv.expires_at IS NULL OR kv.expires_at > now())
LIMIT 1;
```

No row → reject with `payout_not_eligible`. This is defense-in-depth; the primary gate is `provider_profiles.payout_enabled`.

### 4.8 REST API

All endpoints prefixed `/api/v1`. `application/json`. Bearer JWT auth.

#### 4.8.1 Provider-facing

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/kyc/me` | Read own status, document list (no PII fields, no raw URLs) |
| POST | `/kyc/me/uploads/initiate` | Two-phase upload step 1 — pre-signed PUT URL to quarantine prefix (15min TTL) |
| POST | `/kyc/me/uploads/confirm` | Two-phase upload step 2 — blocking HEAD verify, copy to permanent prefix |
| POST | `/kyc/me/submissions` | Submit/resubmit using confirmed upload IDs (validation per §4.4) |
| GET | `/kyc/me/documents/{id}/stream` | App-tier proxy — stream document bytes (chunked, 64KB buffer, 60s timeout) |

#### 4.8.2 Admin-facing (all require SEC-006 re-read)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/kyc` | Paginated queue; filterable by `status`, `submitted_at` range |
| GET | `/admin/kyc/{provider_id}` | Full KYC detail (decrypted PII for admin) |
| GET | `/admin/kyc/{provider_id}/documents/{id}/stream` | Admin streaming proxy (logged to kyc_review_events as `event_type='document_accessed'`) |
| POST | `/admin/kyc/{provider_id}/claim` | Claim review (submitted → in_review) — 429 if admin holds 10 claims |
| POST | `/admin/kyc/{provider_id}/approve` | Approve (single-tx kv + provider_profiles + outbox) |
| POST | `/admin/kyc/{provider_id}/reject` | Reject with rejection_code + per-doc reasons |
| POST | `/admin/kyc/{provider_id}/suspend` | Revoke approval (approved → rejected, payout_enabled=false) |
| POST | `/admin/kyc/{provider_id}/flag-rekyc` | Force re-KYC (immediate payout_enabled=false + kyc.rekyc_required event) |
| POST | `/admin/kyc/{provider_id}/unblock` | Bump submission_limit by 5 (ceiling 20); requires reason_code |

#### 4.8.3 Sample request/response — `POST /kyc/me/submissions`

```json
{
  "documents": [
    {
      "upload_id": "uuid",
      "document_type": "id_card",
      "document_number": "123456789",
      "full_name": "Іванов Іван Іванович",
      "date_of_birth": "1990-05-15",
      "document_expires_at": "2030-05-15"
    },
    {
      "upload_id": "uuid",
      "document_type": "rnokpp",
      "document_number": "3068217500",
      "full_name": "Іванов Іван Іванович"
    },
    {
      "upload_id": "uuid",
      "document_type": "selfie"
    }
  ]
}
```

#### 4.8.4 Sample request — `POST /admin/kyc/{provider_id}/unblock`

```json
{
  "reason_code": "legitimate_documentation_issue",
  "reason_note": "Provider resubmitted corrected passport scan; original rejection was due to image quality."
}
```

`reason_code` enum: `legitimate_documentation_issue | system_error_during_submission | provider_appeal_resolved | other`.

422 `unblock_ceiling_reached` if the bump would exceed 20.

#### 4.8.5 Outbox event registry

| Event | Trigger | Consumed by |
|-------|---------|-------------|
| `kyc.submitted` | Provider POST submission | Notifications |
| `kyc.approved` | Admin approve (atomic with payout_enabled flip) | Notifications, Payments |
| `kyc.rejected` | Admin reject | Notifications |
| `kyc.expired` | Expiry sweep | Notifications, Payments |
| `kyc.rekyc_required` | 30-day pre-expiry warning OR admin flag-rekyc | Notifications |
| `kyc.suspended` | Admin suspend | Notifications, Payments |

### 4.9 Encryption — read/write contract

**Encryption context (AAD), bound on every encrypt and decrypt:**

```json
{ "kek_version": "v2", "document_id": "<uuid>", "provider_id": "<uuid>" }
```

**Write path (re-encryption job):** single atomic UPDATE writes all encrypted columns + kek_version together.

```sql
UPDATE kyc_documents
SET document_number_enc = $new_doc_number_enc,
    full_name_enc       = $new_full_name_enc,
    date_of_birth_enc   = $new_dob_enc,
    kek_version         = $new_kek_version
WHERE id = $document_id
  AND kek_version = $old_kek_version;
```

Returns 0 rows → idempotent skip.

**Read path:**

1. `SELECT document_number_enc, full_name_enc, date_of_birth_enc, kek_version FROM kyc_documents WHERE id = $id` (single SELECT).
2. Build encryption_context using `kek_version` from the SELECT.
3. Call AWS Encryption SDK decrypt with that context.
4. On `AwsEncryptionSdkError` (auth-tag mismatch): single retry — re-read row, rebuild context, decrypt. Second failure → 503 `KMSDecryptionFailure`.
5. Metric: `kyc_decrypt_context_mismatch_total` (counter).

PostgreSQL MVCC guarantees readers see consistent row snapshots; the single-statement UPDATE eliminates split-state hazards.

### 4.10 Document storage

- Bucket: `s3://robotun-kyc-{env}` in same AWS account/region as KYC-PII CMK.
- SSE-KMS with dedicated CMK (separate from media INF-003).
- Cross-region replication: **DISABLED** (data residency, ЗУ Про захист персональних даних).
- Versioning: **ENABLED**.
- Public access: **DISABLED**.
- File key format: `kyc/{provider_id}/{kyc_verification_id}/{document_id}/{upload_uuid_v4}` (no PII in path).
- Quarantine prefix: `kyc/quarantine/{upload_id}` with bucket lifecycle rule auto-deleting after 2 hours.
- Bucket access logs: 1-year retention; access restricted to security/compliance IAM role.
- KYC service IAM on CMK: `kms:Decrypt`, `kms:GenerateDataKey` only.
- CloudWatch alarms on CMK state changes: `Disabled`, `PendingDeletion`, `PendingImport` → P1.

### 4.11 Retention

| Data | Approved KYC | Rejected KYC |
|------|--------------|--------------|
| Raw S3 documents | Purge 3y after `decided_at` | Purge 90d after `decided_at` |
| Encrypted PII columns | Purge 3y after `decided_at` (set NULL) | Purge 90d after `decided_at` |
| `kyc_documents` metadata row (file_key NULL, encrypted columns NULL) | Retain 7y | Retain 3y |
| `kyc_verifications` row | Retain 7y | Retain 3y |
| `kyc_review_events` | Never purged | Never purged |

"Purge" = delete S3 object + set `file_key=NULL` + set encrypted BYTEA columns to NULL. Row shell retained for audit continuity.

Legal basis: ЦК України ст. 257 (3-year statute of limitations for contractual disputes) + legitimate interest (defense against identity-fraud claims). Disclosed in Privacy Policy. AML compliance is NOT claimed.

### 4.12 Timer sweeps

| Sweep | Cadence | Purpose |
|-------|---------|---------|
| Stale-claim eviction | every 5 min | `in_review` rows with `review_started_at <= now()-4h` → back to `submitted`, version++ |
| 30-day pre-expiry warning | daily | `approved AND expires_at <= now()+30d AND rekyc_required_at IS NULL` → emit kyc.rekyc_required |
| Auto-expire | every 1 h | `approved AND expires_at <= now()` → `expired`, payout_enabled=false, outbox kyc.expired |
| Annual re-KYC notification | daily | `approved AND decided_at <= now()-365d AND rekyc_required_reason IS NULL` → emit kyc.rekyc_required (notification only, no auto-expire) |
| Quarantine cleanup | bucket lifecycle (2h) | S3 native rule on `kyc/quarantine/` |
| Reconciliation | every 5 min | bidirectional drift query (§4.6.4) |
| Retention purge | daily | per §4.11 windows |
| KEK re-encryption | on rotation event | per §4.9 write path; idempotent batch of 100 rows |

All sweep UPDATEs include the timer-condition predicate in WHERE for idempotency (PAT-002 from Module 3 reused).

## 5. Acceptance Criteria

- **AC-001**: Given a Provider with valid JWT, When POST `/kyc/me/submissions` with a complete required document set and valid identifier formats, Then a `kyc_verifications` row transitions `not_submitted → submitted` with `submitted_at=now()`, `submission_count++`, and `kyc_documents` rows are created with encrypted PII columns and `kek_version='v1'` (or current).
- **AC-002**: Given a submission with RNOKPP `1234567890` (failing checksum), Then the request is rejected 422 `invalid_rnokpp_checksum` and no DB rows are created.
- **AC-003**: Given a submission missing a selfie, Then the request is rejected 422 `incomplete_document_set`.
- **AC-004**: Given an Admin POST `/admin/kyc/{provider_id}/claim` with SEC-006 OK and the admin holds 9 active claims, Then the claim succeeds and `reviewed_by=admin_id`, `review_started_at=now()`. The 11th attempt returns 429 `claim_limit_exceeded`.
- **AC-005**: Given an Admin POST `/admin/kyc/{provider_id}/approve` with `expires_at` future, valid version, and SEC-006 OK, AND `users.mfa_enabled=true`, Then in a single transaction `kyc_verifications.status='approved'`, `provider_profiles.kyc_status='approved'`, `provider_profiles.payout_enabled=true`, and `kyc.approved` is in outbox.
- **AC-006**: Given the same approval but `users.mfa_enabled=false`, Then `payout_enabled` remains FALSE; the trigger `fn_provider_profiles_payout_mfa_check` raises P0001 if a direct UPDATE attempts to set `payout_enabled=true`.
- **AC-007**: Given an active provider with `payout_enabled=true`, When a direct DB UPDATE attempts `users SET mfa_enabled=false WHERE id=$id`, Then the trigger `fn_users_mfa_payout_check` raises P0001 `cannot_disable_mfa_while_payout_enabled`.
- **AC-008**: Given the reconciliation query runs every 5 min and finds a row with `kv.status IN ('rejected','expired','cancelled') AND pp.payout_enabled=TRUE`, Then the job issues `UPDATE provider_profiles SET payout_enabled=FALSE` for that row AND inserts a `kyc_review_events` row with `event_type='reconciliation_auto_correction'`.
- **AC-009**: Given a Provider with `kyc_documents` from 3 submission attempts, only attempt 3 with `verification_status='accepted'`, When the approve handler computes `expires_at`, Then `expires_at = MIN(document_expires_at)` is taken from attempt 3 documents only (excluding RNOKPP), not from attempts 1 or 2.
- **AC-010**: Given a Provider POST `/kyc/me/uploads/initiate` for a document, Then a presigned PUT URL to `kyc/quarantine/{upload_id}` is returned with 15-min TTL. Given the Provider PUTs successfully then POST `/kyc/me/uploads/confirm`, Then the confirm handler issues a blocking HEAD against the quarantine object; on 200 it server-side-copies to permanent prefix and DELETEs from quarantine. On non-200 HEAD: returns 409 `upload_object_missing`.
- **AC-011**: Given a quarantine object never confirmed, Then the bucket lifecycle rule deletes it after 2 hours.
- **AC-012**: Given an `in_review` row with `review_started_at <= now()-4h`, When the eviction sweep runs, Then `status='submitted'`, `reviewed_by=NULL`, `review_started_at=NULL`, `version++`, and a `kyc_review_events` row records `event_type='claim_evicted'`.
- **AC-013**: Given a Provider with `kyc_verifications.status='rejected'` AND `last_decided_at > now()-24h`, When POST `/kyc/me/submissions`, Then 429 `resubmit_too_soon` with `retry_after` header.
- **AC-014**: Given a Provider with `submission_count=5` AND `submission_limit=5`, When POST `/kyc/me/submissions`, Then 403 `submission_limit_reached`.
- **AC-015**: Given an Admin POST `/admin/kyc/{provider_id}/unblock` with valid `reason_code` and current `submission_limit=15`, Then `submission_limit=20` and a `kyc_review_events` row records the unblock with reason. A subsequent unblock attempt returns 422 `unblock_ceiling_reached`.
- **AC-016**: Given a non-admin GET `/kyc/me`, Then the response includes only `status`, `submitted_at`, `decided_at`, `rejection_code`, document type list, and per-document `verification_status`. It SHALL NOT include `rejection_note`, IP, UA, admin identity, or PII (document_number, full_name, date_of_birth).
- **AC-017**: Given a Provider GET `/kyc/me/documents/{id}/stream`, Then the response is chunked (Transfer-Encoding: chunked or HTTP/2 DATA) and the proxy buffers no more than 64KB at any time. No signed URL is returned.
- **AC-018**: Given an Admin GET `/admin/kyc/{provider_id}/documents/{id}/stream`, Then a `kyc_review_events` row is inserted with `event_type='document_accessed'`, `actor_id=admin_id`, `metadata={"document_id":...}`, IP and UA captured.
- **AC-019**: Given a KEK rotation event, When the re-encryption job UPDATEs a row, Then all 4 columns (document_number_enc, full_name_enc, date_of_birth_enc, kek_version) update in a single statement; concurrent SELECTs see either the pre-rotation snapshot or the post-rotation snapshot, never a mixed state.
- **AC-020**: Given a corrupted encryption context on decrypt (e.g., kek_version mismatch from cache stale), Then AWS Encryption SDK raises auth-tag mismatch; the read path retries once after re-reading the row; second failure returns 503 `KMSDecryptionFailure`; metric `kyc_decrypt_context_mismatch_total` increments.
- **AC-021**: Given a user soft-delete with KYC in `submitted` or `in_review`, Then KYC transitions to `cancelled` and the soft-delete proceeds (NOT blocked). Restore within 90d returns KYC to `not_submitted`.
- **AC-022**: Given a user hard-purge after 90-day soft-delete window, Then `kyc_verifications.provider_id` and `kyc_documents.provider_id` are SET NULL; `kyc_review_events.provider_id` retains the opaque UUID for audit; the purge job does not error.
- **AC-023**: Given a Payments payout-time read, Then it executes the §4.7 SQL and rejects with `payout_not_eligible` if no row returned (e.g., `expires_at <= now()` even though `payout_enabled=true` because the expiry sweep hasn't run yet).

## 6. Test Automation Strategy

- **Test Levels**: Unit (RNOKPP checksum, encryption-context binding, state-machine guards), Integration (REST endpoints + DB + KMS), End-to-End (full flow: upload → confirm → submit → claim → approve → payout-gate read).
- **Frameworks**: language-agnostic. Test harness must support: PostgreSQL 15 testcontainer with triggers loaded, S3-compatible object store (MinIO), AWS Encryption SDK with local KMS mock (LocalStack), Prometheus metric scrape assertions, JWT minting (RS256).
- **Test Data Management**: per-test schema migrations to fresh DB. Seed users + provider role. KMS key created per-suite; rotated mid-test for re-encryption job tests.
- **CI/CD Integration**: full integration suite on every PR. Contract tests against a stub Payments module exercising payout-gate read (§4.7).
- **Coverage Requirements**: ≥ 90% line coverage on KYC service module; 100% branch coverage on state-transition switch.
- **Performance Testing**: loadgen — 100 concurrent provider submissions with 4 docs each (~16MB total per submission); assert p99 latency < 500ms for `/kyc/me/submissions` (excluding upload time). 50 concurrent admin claim+approve cycles; assert no trigger violations and no reconciliation alerts.
- **Race tests** (deterministic): re-encryption job vs concurrent admin read on same row (AC-019, AC-020); claim eviction vs admin approve (AC-012); resubmit during in_review (AC-021 variants).
- **Compliance tests**: validate retention purge job correctly NULLs PII columns at boundary; validate `kyc_review_events` is INSERT-only by attempting UPDATE/DELETE as service role and asserting permission denied.

## 7. Rationale & Context

### Manual review only at MVP (CON-001)

Diia.ID third-party API availability and production-readiness for marketplaces is uncertain at MVP planning time. Commercial OCR/face-match adds ~$0.50–$2 per submission, which is unjustified at projected volumes. Manual admin review with 48-hour SLA is acceptable for an invitation-growth product. Schema reserves `automated_check_result JSONB` for future v2 integration without migration.

### AML claim explicitly dropped (CON-003, CON-004)

Round-1 of orchestration claimed AML retention as legal basis for 5-year retention without performing the AML obligation (sanctions screening). Critic flagged this as internally inconsistent — a false legal-basis claim is worse than no claim. Round-2 revised the rationale to ЦК України ст. 257 (3-year civil statute of limitations) + legitimate interest in dispute defense. Sanctions screening is explicitly deferred to v2; until implemented, the platform MUST NOT advertise AML compliance.

Rejected-KYC raw documents are purged at 90 days (proportionality under ЗУ Про захист персональних даних — no ongoing platform relationship justifies longer raw-doc retention). Approved-KYC raw documents at 3 years (statute of limitations for contractual disputes); metadata rows retained 7 years for decision audit.

### Dual-trigger DB-level enforcement (SEC-007, PAT-002)

The Auth-spec CHECK `(NOT payout_enabled OR kyc_status='approved')` only guards `provider_profiles.kyc_status`, not `users.mfa_enabled`. A direct DB write or buggy MFA-disable handler could leave `payout_enabled=true AND mfa_enabled=false`. The dual triggers close both write paths: trigger A blocks `payout_enabled=true` when MFA is off; trigger B blocks `mfa_enabled=false` when payout is on. Together they form a closed loop on the cross-table invariant — neither side can be broken in a single write.

### Bidirectional reconciliation with asymmetric remediation (PAT-005)

A single-direction reconciliation query missed the financially-exposed direction (KYC revoked, payout still on). Direction B (revoked but payout TRUE) is auto-remediated because every minute of exposure is potential financial loss. Direction A (approved but payout FALSE) is alert-only because automatic re-enable could enable payout during a partially-applied state.

### `expires_at` scoped to current submission (REQ-009 — see KYC-09-R2 in WIP)

`MIN(document_expires_at)` over ALL `kyc_documents` rows for a provider would be poisoned by historical rejected submissions. Scoping to `submission_index = (current submission_count) AND verification_status = 'accepted'` ensures only the documents actually backing the current approval drive the expiry timer. Proactive document renewals don't trigger false-positive expiry.

### App-tier streaming proxy (REQ-013, GUD-004)

Signed URLs returned to clients leak via browser history, referrer headers, screenshots. App-tier proxy centralizes auth, access logging, and PII handling — every byte transit is auditable. Cost: app-tier holds in-flight buffers (~40MB at 10 concurrent admins × 4MB docs). Mitigated by mandatory chunked passthrough (64KB buffer) and deployable separation when sustained concurrency exceeds 20.

### Two-phase upload with quarantine prefix (REQ-005, PAT-004)

Direct upload to permanent prefix risks orphaned PII in the bucket if confirm never arrives. Quarantine prefix isolates pre-confirm uploads with bucket-native lifecycle (2h auto-delete) — no application code needed for cleanup. Confirm handler does mandatory blocking HEAD: catches uploads where the PUT returned 200 to client but propagation to the read endpoint failed.

### Encryption context binding (SEC-003, PAT-003)

AWS Encryption SDK encryption context is included in AAD — any divergence causes auth-tag failure on decrypt, making the KEK-rotation race self-detecting. Binding `{kek_version, document_id, provider_id}` prevents cross-row ciphertext transplant attacks and stale-cache decrypt. Single-statement UPDATE on re-encryption ensures PostgreSQL MVCC delivers consistent row snapshots to concurrent readers.

### Submission ceiling = 20 (CON-010, REQ-012)

Default 5 + 3 unblock cycles × 5 = 20. Three unblocks cover legitimate documentation disputes, edge-case system errors, and one appeal — without enabling indefinite social-engineering escalation. Beyond 20 requires senior-admin oversight (audit break).

### KYC NOT a block on soft-delete (REQ-015)

Unlike open Deals (which DO block soft-delete per Module 3 AC-018), KYC review does not block account deletion. A user wanting to leave the platform mid-review has no financial counterparty waiting on the outcome. KYC transitions to `cancelled` terminal state; admin queue filters it out. Restoration within 90 days returns to `not_submitted` (submission history retained for audit).

### `kyc_review_events.provider_id` has no FK (SEC-006, AC-022)

Audit row must survive user hard-purge for regulatory inspection. Storing the UUID as opaque value (no FK) achieves this without violating the 90-day purge job from Auth spec.

### RNOKPP Euclidean modulo (REQ-004, §4.4.1)

Weight `-1` produces negative intermediate sums. Truncated-division languages (C, Go, Java, JS, Python 2) return negative remainders for negative dividends, miscalculating ~1-in-11 valid RNOKPPs. Euclidean modulo `((sum % 11) + 11) % 11` ensures portability.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001**: Notifications module — consumer of `kyc.submitted`, `kyc.approved`, `kyc.rejected`, `kyc.expired`, `kyc.rekyc_required`, `kyc.suspended` outbox events.
- **EXT-002**: Payments module — consumer of `kyc.approved`, `kyc.expired`, `kyc.suspended`. Reads `provider_profiles.payout_enabled` directly + executes the §4.7 defense-in-depth gate at every payout.
- **EXT-003**: Object storage (S3-compatible) — stores KYC document binaries in dedicated bucket separate from media bucket (CON-001 of Module 3 attachments).

### Third-Party Services
- **SVC-001**: PagerDuty — receives P2 alerts on reconciliation drift; P1 on KMS state changes; P3 on streaming proxy concurrency.

### Infrastructure Dependencies
- **INF-001**: PostgreSQL 15+ — strong consistency for triggers, MVCC for re-encryption race safety, partial indexes, partitioning support, JSONB.
- **INF-002**: AWS KMS (or compatible) — dedicated CMK for KYC PII envelope encryption, separate from media CMK.
- **INF-003**: RS256 key infrastructure (Auth spec) — reused for JWT minting and admin-role validation.
- **INF-004**: AWS Encryption SDK — application-layer envelope encryption with encryption-context binding.
- **INF-005**: Prometheus + Alertmanager — metric collection (`kyc_admin_concurrent_claims`, `kyc_decrypt_context_mismatch_total`, `kyc_document_stream_concurrent_count`, etc.).
- **INF-006**: `outbox_events` table (Category Tree spec) — at-least-once event delivery.
- **INF-007**: CloudWatch (or compatible) — alarms on CMK state changes (`Disabled`, `PendingDeletion`, `PendingImport`).

### Data Dependencies
- **DAT-001**: `users` table (Auth spec) — FK source for `actor_id`; provider_id ON DELETE SET NULL on KYC tables.
- **DAT-002**: `user_roles` table (Auth spec) — SEC-006 admin re-read; new `senior_admin` role added (CON-010 escalation).
- **DAT-003**: `provider_profiles` table (Auth spec) — `kyc_status`, `payout_enabled`, `kyc_verified_at`. Mutated atomically with `kyc_verifications` in same DB transaction.

### Technology Platform Dependencies
- **PLT-001**: PostgreSQL 15+ — `gen_random_uuid()`, partial indexes with expressions, partition by range, BEFORE UPDATE OF column triggers.

### Compliance Dependencies
- **COM-001**: ЗУ Про захист персональних даних (Ukrainian Personal Data Protection Law) — proportionality of retention, classification of access logs as PII, right-to-erasure interaction.
- **COM-002**: ЦК України ст. 257 — 3-year civil statute of limitations cited as legal basis for retention.
- **COM-003**: AML compliance — explicitly NOT claimed at MVP. Retention rationale and Privacy Policy disclosure must be revised if/when sanctions screening is implemented (v2).

## 9. Examples & Edge Cases

### 9.1 Successful happy-path (first-time approval)

```
T0   Provider POST /kyc/me/uploads/initiate (×3)  ──► 3 presigned PUT URLs to kyc/quarantine/{upload_id}
T1   Client PUT to S3 (×3)
T2   Provider POST /kyc/me/uploads/confirm (×3)  ──► HEAD verify, copy to permanent prefix, DELETE quarantine
T3   Provider POST /kyc/me/submissions  ─────────► validates RNOKPP checksum + regexes; encrypts PII; creates kyc_documents rows; status=submitted; outbox kyc.submitted; submission_count=1
T4   Admin POST /admin/kyc/{provider_id}/claim  ──► reviewed_by=admin, status=in_review, version++
T5   Admin reviews via GET /admin/kyc/{provider_id}/documents/{id}/stream  ──► kyc_review_events row event_type=document_accessed
T6   Admin POST /admin/kyc/{provider_id}/approve {expires_at: <doc minimum>}
     ATOMIC TX:
       UPDATE kyc_verifications SET status='approved', decided_at=now(), expires_at=$1, reviewed_by=admin
       UPDATE provider_profiles SET kyc_status='approved', payout_enabled=(SELECT mfa_enabled FROM users WHERE id=$pid)
       INSERT outbox_events ('kyc.approved', ...)
T7   Provider GET /kyc/me  ──► status=approved, payout_enabled=true (if mfa already enrolled)
```

### 9.2 MFA-not-enrolled at approve time

```
T6 (above) — provider has mfa_enabled=false:
   trigger fn_provider_profiles_payout_mfa_check evaluates: NEW.payout_enabled = false (because subquery returns false)
   → constraint passes; payout_enabled stays FALSE
T7   Provider GET /kyc/me  ──► status=approved, payout_enabled=false
T8   Provider POST /users/me/mfa/verify  ──► Auth-spec MFA enrollment handler MUST check kyc_status='approved' and atomically set payout_enabled=TRUE
```

### 9.3 Direction-B drift remediation

```
T0   Approved KYC. provider_profiles.payout_enabled=TRUE.
T1   expires_at <= now(). Auto-expire sweep should run but is delayed.
T1+5min   Reconciliation query (Direction B):
            kv.status='expired' AND pp.payout_enabled=TRUE → row returned.
            Job UPDATE provider_profiles SET payout_enabled=FALSE WHERE user_id=$pid.
            INSERT kyc_review_events event_type='reconciliation_auto_correction'.
T2   PagerDuty P2 fires on the same row (alert + remediation are not exclusive).
```

### 9.4 RNOKPP validation failure

```
POST /kyc/me/submissions { documents: [..., { document_type: "rnokpp", document_number: "1234567890", ...}] }
Server validates:
  digits = [1,2,3,4,5,6,7,8,9,0]
  weights = [-1, 5, 7, 9, 4, 6, 10, 5, 7]
  sum = -1 + 10 + 21 + 36 + 20 + 36 + 70 + 40 + 63 = 295
  ((295 % 11) + 11) % 11 = (9 + 11) % 11 = 9
  9 % 10 = 9
  check digit = 9 ≠ 0 (last digit) → INVALID
→ 422 { error: "validation_failed", fields: [{ field: "rnokpp", code: "invalid_rnokpp_checksum" }] }
```

### 9.5 KEK rotation race

```
T0   Row state: ciphertext=C1, kek_version=v1
T1   Re-encryption job: UPDATE atomically sets ciphertext=C2, kek_version=v2
T1.5 Concurrent admin GET /admin/kyc/.../documents/{id}/stream
     Reader's MVCC snapshot is one of:
       (a) Pre-T1: SELECTs (C1, v1). Builds context with v1. Decrypts → success.
       (b) Post-T1: SELECTs (C2, v2). Builds context with v2. Decrypts → success.
     Reader cannot see (C1, v2) or (C2, v1) — single-statement UPDATE is atomic.
T2   Hypothetical: SDK has cached DEK from v1 in process. Reader sees (C2, v2), context says v2,
     SDK uses cached v1 DEK → auth-tag mismatch → AwsEncryptionSdkError.
     Read path: log warning, single retry — re-read row, rebuild context, request fresh DEK from KMS for v2.
     Second decrypt succeeds.
     Metric kyc_decrypt_context_mismatch_total += 1.
```

### 9.6 Stale-claim eviction

```
T0   Admin POST /claim ──► status=in_review, reviewed_by=admin, review_started_at=T0
T1=T0+4h Admin still on browser, has not approved/rejected.
T1.5 Eviction sweep:
     UPDATE kyc_verifications SET status='submitted', reviewed_by=NULL, review_started_at=NULL, version=version+1
     WHERE status='in_review' AND review_started_at <= now() - interval '4 hours';
     INSERT kyc_review_events event_type='claim_evicted', actor_id=NULL.
T2   Original admin POST /approve with old version → 409 version_conflict.
     Admin sees current state in error response; can re-claim if no other admin took it.
```

### 9.7 Submission ceiling reached

```
Initial: submission_limit=5, submission_count=5 (5 rejections).
6th attempt POST /kyc/me/submissions → 403 submission_limit_reached.
Provider appeals to support. Admin verifies legitimacy.
Admin POST /admin/kyc/{pid}/unblock { reason_code: "provider_appeal_resolved", reason_note: "..." }
  → submission_limit=10. kyc_review_events row written.
Provider resubmits; if rejected again, can submit until count=10.
After two more unblock cycles: submission_limit=20.
A 4th unblock would push to 25 → 422 unblock_ceiling_reached. Senior-admin escalation required.
```

### 9.8 Provider hard-purged after soft-delete

```
T-90d Provider DELETE /users/me → user.deleted_at=T-90d. KYC transitions to cancelled (rekyc_required_reason='account_deleted').
T0   Auth spec hard-purge job: DELETE FROM users WHERE deleted_at <= now()-90d.
     Cascade behavior:
       kyc_verifications.provider_id ON DELETE SET NULL → row retained, provider_id=NULL.
       kyc_documents.provider_id ON DELETE SET NULL → rows retained, provider_id=NULL.
       kyc_review_events.provider_id (no FK) → preserved as opaque UUID.
       kyc_review_events.actor_id (FK) → SET NULL where the purged user was an actor.
T0   Purge succeeds. Audit trail intact.
```

## 10. Validation Criteria

A conforming implementation MUST satisfy:

1. All AC-001 through AC-023.
2. DDL matches §4.1–§4.3 byte-for-byte after normalization (column types, NULL/NOT NULL, FK ON DELETE behavior, CHECK predicates exact). Trigger SQL in §4.6.1–§4.6.2 matches with the normative comment in trigger B.
3. State machine in §4.5 is the authoritative legal-transition list; transitions outside it return 422 `invalid_kyc_transition`.
4. RNOKPP validation uses Euclidean modulo per §4.4.1; the worked example `3068217500` MUST validate as check digit 0.
5. Reconciliation query in §4.6.4 covers BOTH directions (UNION ALL); Direction B includes auto-remediation.
6. Streaming proxy implementation matches §4.10 storage layout AND REQ-013 (no signed URLs returned to clients).
7. Encryption context binding includes all 3 keys (`kek_version`, `document_id`, `provider_id`); decrypt failures with auth-tag mismatch trigger single retry per §4.9.
8. Retention windows match §4.11 exactly; AML compliance MUST NOT be claimed in any external documentation until sanctions screening (v2) is implemented.
9. ON DELETE behavior matches §4.1–§4.3 to ensure Auth-spec 90-day hard-purge does not fail.
10. Bucket configuration matches §4.10: dedicated CMK, no cross-region replication, versioning enabled, no public access, 2-hour quarantine lifecycle.

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-marketplace-social-platform.md`](./spec-architecture-marketplace-social-platform.md) — umbrella; CON-002 (no payment processing at MVP), COM-001 (ЗУ Про захист персональних даних), SEC-004 (this module's identifier).
- [`spec/spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — Module 1; `provider_profiles.payout_enabled`, `provider_profiles.kyc_status`, `users.mfa_enabled`, SEC-006 admin re-read pattern, INF-003 RS256 key infra, REQ-005 MFA + KYC co-requisite for payout, AC-009 soft-delete blocking interaction.
- [`spec/spec-data-category-tree.md`](./spec-data-category-tree.md) — Module 2; `outbox_events` table DDL reused for KYC events.
- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — Module 3; CON-006 (KYC NOT at deal time); `deal.escrow_release_requested` outbox events consumed by Payments module which gates on `payout_enabled` per §4.7.
- Future: `spec/spec-architecture-payments.md` — defines the payout flow that consumes this module's `payout_enabled` flag and KYC outbox events.
- Future: `spec/spec-architecture-sanctions-screening.md` (v2) — when implemented, retention rationale here may be revised to add AML basis.
- Закон України «Про захист персональних даних» — proportionality of retention, access-log classification.
- Цивільний кодекс України, ст. 257 — 3-year statute of limitations cited as retention basis.
