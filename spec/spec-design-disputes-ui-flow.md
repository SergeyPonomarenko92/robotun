---
title: Disputes UI Flow — Client/Provider/Admin End-to-End User Experience
version: 1.0
date_created: 2026-05-08
last_updated: 2026-05-08
owner: Platform / Trust & Safety
tags: [design, disputes, ui-flow, evidence, user-experience]
---

# Introduction

Module 14 — Disputes UI Flow is a design specification covering the end-to-end user experience for deal disputes: client filing, provider counter-evidence, admin review, resolution publication, and post-resolution states. The backend state machine, escrow flows, and outbox events are defined by Deal Workflow, Payments, and Notifications modules; this spec adds the thin evidence schema, API extensions, per-actor visibility rules, user-facing copy templates, and SLA timing chain that turn the existing state machine into a coherent product surface.

## 1. Purpose & Scope

This specification defines:

- A new `dispute_evidence` table — one row per party per dispute, holding the disputing/responding statement and attachment IDs.
- Six-value `deals.dispute_reason` enum (work_not_delivered, work_quality, scope_mismatch, payment_issue, communication_breakdown, other).
- Extended `POST /deals/{id}/dispute` accepting `{reason, statement, attachment_ids[]}`. New `POST /deals/{id}/dispute/respond` for provider counter-evidence.
- Per-actor evidence visibility: client and provider see counterparty statement only after the provider responds OR the response window closes; admin sees both immediately.
- 3-day provider response window; 14-day admin first-review SLA with one 7-day escalation extension (max 21 days from filing — defers to Deal Workflow spec timing math).
- Messaging conversation behavior during `disputed` state: remains OPEN, all messages auto-tagged `admin_visible=true` (overrides Deal Workflow §4.5 lock-on-disputed).
- Resolution finality: no re-dispute or appeal at MVP. Subsequent chargebacks handled by Payments module.
- Four new outbox events emitted: `dispute.evidence_submitted`, `dispute.response_submitted`, `dispute.resolution_published_for_client`, `dispute.resolution_published_for_provider`. Plus `dispute.response_reminder` from timer worker.
- Three new notification codes (Notifications v1.3 amendment): `dispute_response_due_reminder`, `dispute_resolution_published_for_client`, `dispute_resolution_published_for_provider`.
- Ukrainian user-facing copy templates for every dispute-state UI surface.

**Hard prerequisites — Module 14 cannot ship before:**
1. **Media Pipeline v1.2 amendment** — adds `purpose='dispute_evidence'` to CHECK constraint; adds `dispute_evidence_id` FK; updates `chk_exactly_one_owner` to count 5 owner FKs.
2. **Notifications v1.3 amendment** — adds three notification codes to §4.6 catalog; reuses existing `aggregate_type='deal'` allowlist (no allowlist extension needed).
3. **Messaging amendment** — adds `messages.admin_visible BOOLEAN NOT NULL DEFAULT FALSE`; send handler sets to TRUE when `deals.status='disputed'` for the conversation's deal.

**Audience:** product, frontend, backend, T&S operators, legal/compliance.

**Assumptions:** Modules 1–13 finalized. Deal Workflow state machine §4.5, Notifications worker scan §4.2, Media Pipeline §4.1, Messaging conversation lock semantics, Admin Tooling MFA challenge model.

**Out of scope:** mediation by third-party arbitrator, partial evidence submission (drafts/patches), multi-round evidence exchange (rebuttal/sur-rebuttal), dispute analytics dashboard, mobile UI layout, deal disputes from `active` state pre-submission (Deal spec gates on `in_review`), chargebacks (Payments module owns post-resolution PSP-initiated reversals), reviews on disputed deals (Reviews module blocks until terminal non-disputed state).

## 2. Definitions

- **Dispute** — formal disagreement raised by Client during `in_review` or 24h grace window after `completed`. Transitions deal to `status='disputed'`.
- **Evidence** — `dispute_evidence` row containing one party's statement (30–4000 chars) and attachment IDs (0–5 from `media_objects` with `purpose='dispute_evidence'`).
- **Response window** — 3 days from `dispute_opened_at` during which provider may submit counter-evidence.
- **Escalation** — Deal-spec timer that fires at `dispute_resolve_by` if unresolved, extending by 7 days; second expiry triggers forced refund.
- **Resolution outcome** — admin's verdict: `release_to_provider`, `refund_to_client`, or `split` (with `release_amount_kopecks`).
- **Forced resolution** — `dispute_unresolved` event fired by Deal-spec timer at second expiry; defaults to refund-to-client.
- **`admin_visible`** — message flag set when sent during `disputed` state; surfaces the message in admin's dispute review.

## 3. Requirements, Constraints & Guidelines

### Requirements

- **REQ-001** — `dispute_evidence` table holds at most 2 rows per `deal_id` (one per `party_role`). UNIQUE constraint enforces this.
- **REQ-002** — `deals.dispute_reason` is one of six fixed enum values; CHECK constraint enforces.
- **REQ-003** — `POST /deals/{id}/dispute` extended payload: `{reason ENUM, statement TEXT 30-4000, attachment_ids UUID[] 0-5}`. Atomic side effects: deal UPDATE, dispute_evidence INSERT, deal_events INSERT, two outbox events (`deal.disputed` + `dispute.evidence_submitted`).
- **REQ-004** — `POST /deals/{id}/dispute/respond` requires `deals.status='disputed'`, `now() <= provider_response_due_at`, caller is the deal's `provider_id`, no existing `dispute_evidence (party_role='provider')` row. Errors: `409 dispute_response_already_submitted`, `409 dispute_response_window_closed`.
- **REQ-005** — `provider_response_due_at = dispute_opened_at + 3 days` set by `/dispute` handler.
- **REQ-006** — Visibility rule: counterparty statement is hidden until provider responds OR `provider_response_due_at < now()`. Admin sees both immediately.
- **REQ-007** — Conversation remains writable during `disputed`. Messaging send handler sets `messages.admin_visible=TRUE` for messages on conversations whose deal is in `disputed` state. Conversation locks only on terminal resolution.
- **REQ-008** — Resolution is final. `POST /dispute` on a deal with `resolution_outcome IS NOT NULL` returns `409 deal_already_resolved`.
- **REQ-009** — GDPR erasure on `user.gdpr_erased_*`: NULL `dispute_evidence.statement` for the erased user; retain `deal_id`, `party_role`, `submitted_at`, `attachment_ids` for 7 years.
- **REQ-010** — Evidence attachments use `media_objects` with `purpose='dispute_evidence'`. `deal_attachments` table is NOT used for evidence. Attachment caps: max 5 per submission, 10 MB per file, allowed MIME `image/jpeg|png|webp` and `application/pdf`.
- **REQ-011** — Timer worker emits `dispute.response_reminder` at `provider_response_due_at - 24h` for any `disputed` deal where `provider_responded_at IS NULL`.
- **REQ-012** — Outbox events emitted with `aggregate_type='deal'`: `dispute.evidence_submitted`, `dispute.response_submitted`, `dispute.response_reminder`, `dispute.resolution_published_for_client`, `dispute.resolution_published_for_provider`.
- **REQ-013** — Notifications v1.3 catalog entries: `dispute_response_due_reminder` (provider, in_app+email+push, MANDATORY — quiet-hours bypass; legal-deadline-bearing per Notifications v1.3 §4.6), `dispute_resolution_published_for_client` (client, all channels, MANDATORY), `dispute_resolution_published_for_provider` (provider, all channels, MANDATORY).
- **REQ-014** — `GET /deals/{id}/dispute` (party-filtered view) and `GET /admin/deals/{id}/dispute` (full admin view) return current dispute state, evidence (party-filtered for party callers), timing, resolution, and copy strings.

### Security

- **DSP-SEC-001** — Statement is PII; never logged in plaintext (only `statement_length` integer in audit metadata).
- **DSP-SEC-002** — Admin resolution endpoint inherits Admin Tooling MFA challenge requirement (REQ-009 of Admin Tooling). Admin role re-read per request (SEC-006).
- **DSP-SEC-003** — Counterparty statement visibility gate (REQ-006) enforced server-side — never trust client to filter response data.
- **DSP-SEC-004** — Attachment authorization at evidence submission: `media_objects.owner_user_id = caller AND purpose='dispute_evidence' AND status='ready'`. Cross-user attachment reference returns `422 attachment_not_found`.
- **DSP-SEC-005** — Conversation `admin_visible=TRUE` flag is server-set; client cannot opt out. Both parties are informed via UI banner that messages during dispute are admin-visible (transparency requirement).

### Constraints

- **DSP-CON-001** — Module 14 cannot ship before Media Pipeline v1.2 amendment (purpose extension + `dispute_evidence_id` FK).
- **DSP-CON-002** — Module 14 cannot ship before Notifications v1.3 amendment (three new catalog rows).
- **DSP-CON-003** — Module 14 cannot ship before Messaging amendment (`admin_visible` column on `messages` + send handler logic).
- **DSP-CON-004** — Total dispute timing window is **21 days** maximum (14d first review + 7d extension), per Deal Workflow spec §4.5 timer math. The "31 days" target in the original scope document conflicts with Deal spec; this module defers to Deal spec as authoritative. Changing to 31 days requires a Deal Workflow v1.2 amendment changing the `+7d` extension to `+17d`.
- **DSP-CON-005** — One-shot submission per party. No drafts, no patches, no appeals at MVP.
- **DSP-CON-006** — Statement min length 30 chars (prevents low-effort disputes); max 4000 chars (prevents PII spillage and cost).
- **DSP-CON-007** — `dispute_evidence` rows are never DELETEd; statement is NULL'd on GDPR erasure but row retained (FK referenced by `media_objects.dispute_evidence_id`).

### Guidelines

- **DSP-GUD-001** — User-facing copy is in `uk` (Ukrainian) at MVP; localization deferred. Templates use `{var}` substitution for dynamic fields.
- **DSP-GUD-002** — Admin's `recommended_action_copy` field in `GET /admin/deals/{id}/dispute` is advisory only; admin always uses judgment. The recommendation is generated from `prior_disputes_between_parties` heuristic and `provider_responded` flag.
- **DSP-GUD-003** — When provider does NOT respond by `provider_response_due_at`, automatic refund-to-client is NOT applied. Admin must still resolve. Rationale: prevents fraud-by-spurious-dispute when provider is temporarily unavailable.
- **DSP-GUD-004** — All dispute-related notifications are mandatory class (security/compliance event for users) — bypass user preferences and quiet hours.

### Patterns

- **DSP-PAT-001** — One-row-per-party evidence model: enforces one-shot submission; UNIQUE(`deal_id`, `party_role`).
- **DSP-PAT-002** — Hidden-until-window-closes counterparty statement: applied at projection layer in `GET /dispute` response builder.
- **DSP-PAT-003** — Atomic dispute filing: deal UPDATE + dispute_evidence INSERT + deal_events INSERT + outbox events all in single transaction.

## 4. Interfaces & Data Contracts

### 4.1 Schema

```sql
-- 4.1.1 dispute_evidence
CREATE TABLE dispute_evidence (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         UUID        NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  submitted_by    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  party_role      TEXT        NOT NULL CHECK (party_role IN ('client','provider')),
  statement       TEXT        CHECK (statement IS NULL OR char_length(statement) BETWEEN 30 AND 4000),  -- v1.0.1: NULLable to allow GDPR erasure (REQ-009/AC-009/DSP-CON-007); 30..4000 enforced at INSERT by application + this CHECK
  attachment_ids  UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dispute_evidence_party UNIQUE (deal_id, party_role)
);
CREATE INDEX idx_dispute_evidence_deal ON dispute_evidence (deal_id);
CREATE INDEX idx_dispute_evidence_user ON dispute_evidence (submitted_by);

-- 4.1.2 deals amendment
ALTER TABLE deals
  ADD COLUMN dispute_reason TEXT
    CHECK (dispute_reason IN (
      'work_not_delivered','work_quality','scope_mismatch',
      'payment_issue','communication_breakdown','other'
    )),
  ADD COLUMN provider_response_due_at TIMESTAMPTZ,
  ADD COLUMN provider_responded_at    TIMESTAMPTZ;

-- 4.1.3 Media Pipeline v1.2 (prereq)
-- See spec-architecture-media-pipeline.md v1.2:
--   purpose CHECK adds 'dispute_evidence'
--   ADD COLUMN dispute_evidence_id UUID REFERENCES dispute_evidence(id) ON DELETE SET NULL
--   chk_exactly_one_owner now sums 5 columns
--   chk_purpose_fk_dispute: purpose<>'dispute_evidence' OR dispute_evidence_id IS NOT NULL
--   idx_media_objects_dispute partial index

-- 4.1.4 Messaging amendment (prereq)
-- ALTER TABLE messages ADD COLUMN admin_visible BOOLEAN NOT NULL DEFAULT FALSE;
-- Send handler sets admin_visible=TRUE if deal.status='disputed' for the conversation's deal.

-- 4.1.5 Timer worker partial index (REQ-011)
CREATE INDEX idx_deals_dispute_response_pending
  ON deals (provider_response_due_at)
  WHERE status = 'disputed' AND provider_responded_at IS NULL;
```

### 4.2 Reason Taxonomy

| Code | UA label | When to use |
|---|---|---|
| `work_not_delivered` | Роботу не виконано | No delivery after activation |
| `work_quality` | Неякісне виконання | Defective or incomplete work |
| `scope_mismatch` | Невідповідність обсягу | Differs from agreement |
| `payment_issue` | Проблема з оплатою | Price/funds dispute |
| `communication_breakdown` | Відсутність зв'язку | Provider went silent |
| `other` | Інше | Catch-all; admin may reclassify |

### 4.3 REST API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/api/v1/deals/{id}/dispute` | client | Extended: `{reason, statement, attachment_ids}` |
| POST | `/api/v1/deals/{id}/dispute/respond` | provider | New: counter-evidence submission |
| GET | `/api/v1/deals/{id}/dispute` | client \| provider \| admin | New: party-filtered dispute view |
| GET | `/api/v1/admin/deals/{id}/dispute` | admin | New: full admin view |
| POST | `/api/v1/admin/deals/{id}/resolve` | admin (+ MFA) | Existing in Deal Workflow §4.6.4; unchanged |

**`POST /deals/{id}/dispute` request:**

```json
{
  "version": 5,
  "reason": "work_quality",
  "statement": "Виконана робота не відповідає погодженому ТЗ. Встановлений компонент має дефекти, задокументовані на фото.",
  "attachment_ids": ["uuid-photo-1", "uuid-photo-2"]
}
```

Validation:
- `reason` in enum → `422 invalid_dispute_reason`
- `statement` 30–4000 chars → `422 statement_too_short` / `422 statement_too_long`
- `attachment_ids` 0–5 elements; each owned by caller, purpose='dispute_evidence', status='ready' → `422 attachment_not_found` / `422 too_many_attachments`
- `deals.resolution_outcome IS NULL` → `409 deal_already_resolved`

Atomic transaction (single COMMIT):
1. UPDATE deals SET status='disputed', dispute_reason, dispute_opened_at=now(), provider_response_due_at=now()+'3d', dispute_resolve_by=now()+'14d', version=version+1.
2. INSERT INTO dispute_evidence (deal_id, submitted_by, party_role='client', statement, attachment_ids).
3. INSERT INTO deal_events (event_type='deal.disputed', actor_id=client, metadata: {reason, statement_length, attachment_count}).
4. INSERT INTO outbox_events (event_type='deal.disputed', aggregate_type='deal').
5. INSERT INTO outbox_events (event_type='dispute.evidence_submitted', aggregate_type='deal').

Response:
```json
{
  "id": "deal-uuid",
  "status": "disputed",
  "version": 6,
  "dispute_reason": "work_quality",
  "dispute_opened_at": "2026-05-08T10:00:00Z",
  "provider_response_due_at": "2026-05-11T10:00:00Z",
  "dispute_resolve_by": "2026-05-22T10:00:00Z"
}
```

**`POST /deals/{id}/dispute/respond` request:**

```json
{
  "version": 6,
  "statement": "Роботу виконано згідно з погодженим переліком. Фото клієнта зроблені до встановлення захисного покриття.",
  "attachment_ids": ["uuid-counter-1"]
}
```

Atomic transaction:
1. INSERT INTO dispute_evidence (deal_id, submitted_by=provider, party_role='provider', statement, attachment_ids).
2. UPDATE deals SET provider_responded_at=now(), version=version+1.
3. INSERT INTO deal_events (event_type='deal.dispute_response_submitted', actor_id=provider, metadata).
4. INSERT INTO outbox_events (event_type='dispute.response_submitted', aggregate_type='deal').

### 4.4 `GET /deals/{id}/dispute` — party-filtered view

**Caller = client (before provider responds):**

```json
{
  "deal_id": "uuid",
  "status": "disputed",
  "dispute_reason": "work_quality",
  "dispute_reason_label": "Якість роботи",
  "dispute_opened_at": "2026-05-08T10:00:00Z",
  "dispute_resolve_by": "2026-05-22T10:00:00Z",
  "provider_response_due_at": "2026-05-11T10:00:00Z",
  "provider_responded_at": null,
  "escalation_count": 0,
  "your_evidence": {
    "statement": "Виконана робота не відповідає...",
    "submitted_at": "2026-05-08T10:00:00Z",
    "attachments": [{ "media_id": "uuid", "filename": "photo1.jpg", "stream_url": "..." }]
  },
  "counterparty_evidence": { "submitted": false, "statement": null, "attachments": [] },
  "resolution": null,
  "status_copy": {
    "headline": "Ваш спір розглядається",
    "detail": "Виконавець має час до 11 трав. 2026 р. надати свою позицію."
  }
}
```

**Caller = provider (before responding, sees client statement is HIDDEN):**

```json
{
  "deal_id": "uuid",
  "status": "disputed",
  "dispute_reason": "work_quality",
  "dispute_reason_label": "Якість роботи",
  "dispute_opened_at": "2026-05-08T10:00:00Z",
  "provider_response_due_at": "2026-05-11T10:00:00Z",
  "your_evidence": null,
  "counterparty_evidence": {
    "submitted": true,
    "statement": null,
    "attachments": []
  },
  "your_response_required": true,
  "status_copy": {
    "headline": "Клієнт відкрив спір",
    "detail": "Причина: Якість роботи. Надайте вашу позицію до 11 трав. 2026 р. (3 дні)."
  }
}
```

**After provider responds OR window closes:** both parties see counterparty `statement` and `attachments`.

### 4.5 `GET /admin/deals/{id}/dispute` — full view

```json
{
  "deal": { "...full deal fields..." },
  "dispute_reason": "work_quality",
  "client_evidence": {
    "statement": "...",
    "submitted_at": "...",
    "attachments": [{ "media_id": "uuid", "stream_url": "..." }]
  },
  "provider_evidence": {
    "statement": "...",
    "submitted_at": "...",
    "attachments": [],
    "no_response": false
  },
  "deal_history": [{ "event_type": "deal.created", "created_at": "...", "actor_role": "client" }],
  "prior_disputes_between_parties": {
    "count": 1,
    "last_outcome": "refund_to_client",
    "last_resolved_at": "2025-11-10T09:00:00Z"
  },
  "provider_rating_snapshot": {
    "average": 4.2,
    "total_reviews": 38,
    "completed_deals": 52
  },
  "escalations": [],
  "messages_during_dispute": [
    {
      "message_id": "uuid",
      "sender_role": "client",
      "body": "...",
      "created_at": "...",
      "admin_visible": true
    }
  ],
  "recommended_action_copy": "Виконавець не відповів. Рекомендовано розглянути відшкодування клієнту."
}
```

`prior_disputes_between_parties` query (read-only at access time):
```sql
SELECT COUNT(*) AS count,
       MAX(resolution_outcome) AS last_outcome,
       MAX(resolved_at) AS last_resolved_at
FROM deals
WHERE (client_id = $client_id AND provider_id = $provider_id)
  AND status IN ('completed','cancelled')
  AND resolution_outcome IS NOT NULL
  AND id <> $current_deal_id;
```

### 4.6 SLA Timing Chain

```
T0       Client POST /deals/{id}/dispute → dispute_opened_at = T0
T0       provider_response_due_at = T0 + 3 days
T0       dispute_resolve_by = T0 + 14 days

T0+24h_before_due  Timer worker emits dispute.response_reminder (REQ-011)
T0+3d              Provider response window closes; if no response, no_response=true
T0+14d             Admin SLA expires; escalation sweep extends dispute_resolve_by += 7d, escalation_count=1
T0+21d             Second expiry; if still unresolved, deal.dispute_unresolved emitted (forced refund)

Total max = 21 days (Deal Workflow spec §4.5 authoritative).
```

### 4.7 Outbox Events Emitted

| Event type | aggregate_type | Trigger | Payload |
|---|---|---|---|
| `dispute.evidence_submitted` | `deal` | Client `/dispute` success | `{deal_id, client_id, provider_id, reason, attachment_count}` |
| `dispute.response_submitted` | `deal` | Provider `/dispute/respond` success | `{deal_id, client_id, provider_id, attachment_count}` |
| `dispute.response_reminder` | `deal` | Timer at `provider_response_due_at - 24h` | `{deal_id, provider_id, due_at}` |
| `dispute.resolution_published_for_client` | `deal` | Admin `/resolve` success | `{deal_id, client_id, outcome, refund_amount_kopecks}` |
| `dispute.resolution_published_for_provider` | `deal` | Admin `/resolve` success | `{deal_id, provider_id, outcome, release_amount_kopecks}` |

Existing Deal Workflow events `deal.disputed`, `deal.dispute_resolved`, `deal.dispute_escalated`, `deal.dispute_unresolved` remain unchanged.

### 4.8 Notifications v1.3 Catalog Amendment

| Code | Trigger event | Recipient | In-app | Email | Push | Mandatory |
|---|---|---|---|---|---|---|
| `dispute_response_due_reminder` | `dispute.response_reminder` | provider | ✓ | ✓ | ✓ | ✓ |
| `dispute_resolution_published_for_client` | `dispute.resolution_published_for_client` | client | ✓ | ✓ | ✓ | ✓ |
| `dispute_resolution_published_for_provider` | `dispute.resolution_published_for_provider` | provider | ✓ | ✓ | ✓ | ✓ |

All three have `digest_eligible=false` (immediate). The two resolution codes are mandatory (bypass user preferences).

## 5. Acceptance Criteria

- **AC-001** — Given a deal in `in_review`, When client `POST /dispute` with `reason=work_quality`, valid statement, valid attachment_ids, Then deal transitions to `disputed`; `dispute_evidence` row inserted with `party_role='client'`; outbox events `deal.disputed` and `dispute.evidence_submitted` emitted in same TX.
- **AC-002** — Given a `disputed` deal where provider has not yet responded, When provider calls `POST /dispute/respond`, Then second `dispute_evidence` row inserted with `party_role='provider'`; `provider_responded_at` set; `dispute.response_submitted` emitted.
- **AC-003** — Given provider attempts to respond after `provider_response_due_at`, When request fires, Then `409 dispute_response_window_closed` returned.
- **AC-004** — Given client `GET /dispute` before provider responds, Then `counterparty_evidence.statement = null` and `counterparty_evidence.submitted = false`.
- **AC-005** — Given provider responds, Then on next `GET /dispute` by client, `counterparty_evidence.statement` is populated.
- **AC-006** — Given provider response window expires without response, Then on `GET /dispute` by client, `counterparty_evidence.statement` becomes visible (was hidden, now revealed by window-close rule).
- **AC-007** — Given a resolved dispute, When client `POST /dispute` again, Then `409 deal_already_resolved`.
- **AC-008** — Given admin `POST /resolve` with `outcome=split, release_amount_kopecks=50100`, When the resolution commits, Then `dispute.resolution_published_for_client` AND `dispute.resolution_published_for_provider` outbox events emitted with per-party amounts.
- **AC-009** — Given GDPR erasure for a client, When erasure handler runs, Then `dispute_evidence.statement` is NULL'd for that user's submissions; `deal_id`, `party_role`, `attachment_ids`, `submitted_at` retained.
- **AC-010** — Given `provider_response_due_at = T0 + 3d`, When timer worker scans at T0 + 2d, Then `dispute.response_reminder` outbox event emitted for that deal.
- **AC-011** — Given a message sent during `disputed` state, When persisted, Then `messages.admin_visible = TRUE`.
- **AC-012** — Given `dispute.resolution_published_for_client` event with `aggregate_type='deal'`, When Notifications worker scans, Then event is consumed via existing allowlist (no v1.x consumer-side amendment needed beyond catalog rows).
- **AC-013** — Given client submits dispute with `attachment_ids` referencing media owned by a different user, When validation runs, Then `422 attachment_not_found`.
- **AC-014** — Given statement length 29 chars, When `POST /dispute`, Then `422 statement_too_short`.
- **AC-015** — Given a provider with no prior disputes, When admin `GET /admin/deals/{id}/dispute`, Then `prior_disputes_between_parties.count = 0` and `last_outcome = null`.

## 6. Test Automation Strategy

- **Test Levels:** Unit (visibility-rule projection logic, copy template substitution, validation rules), Integration (atomic transaction commit semantics, response-window race, GDPR erasure), End-to-End (full client/provider/admin flow with mock PSP).
- **Frameworks:** project-default backend test stack.
- **Test Data:** seeded deals in `in_review` state; mock `media_objects` with `purpose='dispute_evidence'`; admin user with MFA-enrolled session.
- **CI/CD:** integration tests run on every PR. Visibility-rule tests assert response shape for client/provider/admin in pre-response and post-response states.
- **Coverage:** ≥85% on dispute service.
- **Performance:** dispute filing p99 < 200 ms; admin dispute view (5 source tables joined) p99 < 500 ms.

## 7. Rationale & Context

**Why one-shot per-party submission:** drafts and revisions multiply complexity (draft state, edit history, race between admin start of review and party edit). One atomic commit per side keeps the audit trail clear and matches industry norms (eBay, Upwork dispute flows).

**Why hidden counterparty statement until window closes:** if the provider sees the client's full statement immediately, they tailor counter-evidence to rebut each point (cross-examination advantage). Withholding produces fairer parallel statements. Both visible after submission/window-close gives users the resolution context.

**Why conversation stays open during dispute:** locking eliminates the most natural resolution path (direct clarification). `admin_visible` flag preserves evidentiary value without forcing all communication through admin.

**Why no auto-refund on no-response:** spurious dispute filing while provider is temporarily unavailable (illness, vacation) would be a fraud vector. Admin judgment with `no_response=true` flag balances throughput against fairness.

**Why 3-day response window:** longer windows extend average dispute cycle materially. 3 days is the minimum commercially reasonable window without making the platform unfair to providers with weekend timing.

**Why Media Pipeline `purpose='dispute_evidence'` over `deal_attachments`:** evidence requires GDPR erasure path (statement NULL'd, attachments retained metadata-only). `media_objects` already has `expires_at`, `deleted_at`, purpose-keyed authorization; `deal_attachments` does not. Reusing the Media Pipeline avoids duplicating GDPR machinery.

**Why three notification codes (not one with branch logic):** distinct codes per recipient role + per outcome let template authoring stay simple (one template per code, no conditional branches). Mandatory flag is per-code, also cleaner.

**Why 21-day max (not 31):** deferring to Deal Workflow spec §4.5 authoritative timer math. Changing to 31 days requires explicit Deal Workflow v1.2 amendment.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** — None (in-process).

### Third-Party Services
- **SVC-001** — Notifications module delivery (consumes `dispute.*` events).
- **SVC-002** — Media Pipeline upload/scan (Media Pipeline v1.2).

### Infrastructure Dependencies
- **INF-001** — PostgreSQL 15+.
- **INF-002** — Existing outbox + relay worker.
- **INF-003** — Timer worker for dispute reminder (60-second polling cadence).

### Data Dependencies
- **DAT-001** — `deals` (Deal Workflow), `users`, `messages` (Messaging), `media_objects` (Media Pipeline v1.2).

### Technology Platform Dependencies
- **PLT-001** — PostgreSQL 15+ for partial indexes and CHECK constraints.

### Compliance Dependencies
- **COM-001** — GDPR Art. 6(1)(c) — legal basis for retention during resolution and 7-year audit window.
- **COM-002** — GDPR Art. 17 — right to erasure (statement NULL on user.gdpr_erased_*).
- **COM-003** — Ukrainian Law on Consumer Protection (governs the substantive dispute resolution; this spec covers the procedural mechanics).

## 9. Examples & Edge Cases

### 9.1 Successful client-wins-split outcome

```
T0    Client POST /dispute (work_quality, 3 attachments)
T0+1d Provider POST /dispute/respond (1 attachment)
T0+2d Admin reviews, runs prior-disputes heuristic (0 prior disputes)
T0+2d Admin POST /resolve {outcome=split, release_amount_kopecks=50100} (with MFA token)
      → deals.status='completed' (split is a completion path with partial refund)
      → ledger entries: provider net=45090, platform fee=5010, refund=49800
      → dispute.resolution_published_for_client + ..._for_provider events emitted
      → mandatory notifications dispatched
```

### 9.2 Edge case — provider no-response

```
T0    Client POST /dispute (statement + attachments)
T0+2d Timer worker emits dispute.response_reminder → provider notification sent
T0+3d provider_response_due_at expires; provider_responded_at IS NULL
T0+5d Admin GET /admin/deals/.../dispute shows no_response=true
T0+5d Admin POST /resolve {outcome=refund_to_client} (admin judgment, MFA)
      → escrow refund, ledger entries
      → resolution notifications
```

### 9.3 Edge case — chargeback after dispute resolution

Resolution issued at T+5d (refund to client, deal cancelled). At T+30d, PSP issues chargeback against the original capture. This is OUT OF SCOPE for Module 14 — Payments chargeback flow handles it independently. The dispute resolution is final at the platform level; the chargeback is a separate financial dispute at the bank level.

## 10. Validation Criteria

A compliant implementation MUST:

1. Pass AC-001 through AC-015.
2. Reject any code path that allows multi-submission per party per dispute (UNIQUE constraint on `(deal_id, party_role)`).
3. Reject any code path that returns counterparty `statement` to a party before the visibility window opens.
4. Reject any code path that DELETEs a `dispute_evidence` row (use NULL-on-statement pattern).
5. Reject any attachment reference to `media_objects` without `purpose='dispute_evidence'` for evidence submissions.
6. Verify timer worker partial index `idx_deals_dispute_response_pending` exists and is used by the reminder sweep (EXPLAIN assertion).
7. Verify admin `/resolve` endpoint requires MFA challenge (Admin Tooling REQ-009).
8. Verify GDPR erasure NULL-out test: statement disappears, structural row remains.

## 11. Related Specifications / Further Reading

- [`spec/spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — state machine, dispute_escalations, /resolve endpoint, timer math (21-day cap authoritative).
- [`spec/spec-architecture-payments.md`](./spec-architecture-payments.md) — escrow refund/release/split mechanics; chargeback flow (separate from dispute).
- [`spec/spec-architecture-messaging.md`](./spec-architecture-messaging.md) — **REQUIRES amendment** for `messages.admin_visible` column + send handler logic during disputed state.
- [`spec/spec-architecture-media-pipeline.md`](./spec-architecture-media-pipeline.md) — **REQUIRES v1.2 amendment** for `purpose='dispute_evidence'` + `dispute_evidence_id` FK.
- [`spec/spec-architecture-notifications.md`](./spec-architecture-notifications.md) — **REQUIRES v1.3 amendment** for three new notification codes in §4.6 catalog.
- [`spec/spec-architecture-admin-tooling.md`](./spec-architecture-admin-tooling.md) — admin queue surfaces dispute_escalations; MFA challenge required for /resolve.
- [`spec/spec-architecture-reviews.md`](./spec-architecture-reviews.md) — reviews blocked on disputed deals.
