---
title: Reviews — Two-Sided Post-Deal Review System
version: 1.0
date_created: 2026-05-07
last_updated: 2026-05-07
owner: Platform / Backend
tags: [architecture, reviews, reputation, moderation, gdpr]
---

# Introduction

This module specifies the **Reviews** subsystem: the post-deal, two-sided review and rating mechanism. Both Client and Provider may rate each other after a Deal reaches a terminal "value-exchanged" state. Reviews drive the public reputation surface of Listings and Provider profiles and feed into the future Feed/search ranking pipeline.

The module owns the `reviews`, `review_replies`, `review_reply_audit`, `review_reports`, `review_windows`, `listing_rating_aggregates`, and `provider_rating_aggregates` tables, the blind-reveal sweep, the eligibility consumer for Deal outbox events, the moderation surface, and the GDPR erasure hooks for review-author identity.

This module **adds two columns** to `listings` (`avg_rating`, `review_count`) for read-path denormalization and **adds equivalent columns** to `provider_profiles`. It does **not** alter existing Deal, Auth, or Media Pipeline contracts.

## 1. Purpose & Scope

Define the data model, eligibility lifecycle, blind-reveal mechanics, asymmetric rating schema, asynchronous aggregation pipeline, moderation flow, anti-abuse controls, GDPR erasure hooks, and integration contracts for two-sided reviews in the Robotun marketplace.

**In scope.**
- Eligibility derived from Deal terminal state (approved, auto-completed, dispute-resolved with value-exchange outcome).
- Review schema with asymmetric sub-criteria (Client→Provider has 3 sub-criteria; Provider→Client has none).
- Blind reveal: both-submitted OR per-row 14-day fallback OR 90-day window close.
- Asynchronous aggregation of listing and provider ratings via outbox.
- Review reply (one per review, edit-audited).
- Reports, qualifying-reporter gate, admin-only takedown.
- Visibility enforcement via Postgres RLS.
- Review attachments via the existing Media Pipeline (`purpose='review_attachment'`).
- GDPR erasure of reviewer identity and free-text PII.

**Out of scope.**
- Notification transport (events emitted, delivery owned by future Notifications module).
- Search/Feed ranking weights derived from ratings.
- ML-based fake-review detection beyond the qualifying-reporter gate.
- Client public profile UI (Provider→Client reviews exist in schema but the consumer surface is deferred).
- Multi-media review galleries; max 3 attachments per review.
- Review incentive/gamification programs.
- Review import or migration from external platforms.
- Structured appeal workflow for replies (only the parent review is reportable).

**Audience.** Backend engineers, platform engineers, moderation tooling team, Listings/Feed module owners, compliance/legal.

**Assumptions.** PostgreSQL 15+ with `pgcrypto` and Row-Level Security enabled; the Deal Workflow, Listings, Media Pipeline, Users/Auth, and KYC modules are deployed per their finalized specs; standard `outbox_events` table from the Deal spec is the cross-module event bus; `provider_profiles` table from the Auth spec exists.

## 2. Definitions

| Term | Definition |
|---|---|
| Review | A row in `reviews` representing one party's rating + comment for one Deal. At most two per Deal: one Client→Provider, one Provider→Client. |
| Review window | A row in `review_windows` keyed on `deal_id` defining when reviews may be submitted; `eligible_from` and `eligible_until = eligible_from + 90d`. |
| Blind reveal | Mechanic by which a submitted review remains invisible to the counterparty until both parties submit OR a 14-day per-row timer elapses OR the 90-day window closes. Encoded as `revealed_at TIMESTAMPTZ` and gated by `status='published'`. |
| `both_submitted` | Trigger-maintained boolean column on `reviews` indicating both Client and Provider rows for the same `deal_id` are in `status='published'`. |
| Reply | A response by the reviewee to a review; one per review, edits audited append-only. |
| Qualifying reporter | A user satisfying any of: `kyc_approved=true`, `completed_deals_count ≥ 1`, `account_age_days ≥ 7` — same definition as Listings spec SEC-003. |
| Aggregation worker | A background consumer subscribed to `review.submitted` and `review.status_changed` outbox events that recomputes denormalized rating aggregates. |
| `review_attachment` | New `media_objects.purpose` value for review-attached images, owned via a new `media_objects.review_id` FK. |
| Sentinel-erased review | A review whose `reviewer_id` and `comment` have been NULLed by the GDPR erasure handler; the row is retained for referential integrity and aggregate stability. |
| RLS role split | Pattern where the application user role is subject to RLS on `reviews`, while the aggregation worker invokes a `SECURITY DEFINER` function rather than holding `BYPASSRLS` globally. |

## 3. Requirements, Constraints & Guidelines

### Functional requirements

- **REQ-001** The system SHALL create a `review_windows` row for a Deal exactly once, on receipt of one of: `deal.approved`, `deal.auto_completed`, or `deal.dispute_resolved` with `outcome ∈ {release_to_provider, split}`.
- **REQ-002** The system SHALL NOT create a `review_windows` row for `deal.dispute_resolved` with `outcome=refund_to_client` or for `deal.dispute_unresolved`. For `deal.dispute_unresolved`, if a `review_windows` row exists from an earlier transition it SHALL be marked `eligible=false` with `ineligibility_reason='dispute_unresolved_refund_to_client'`.
- **REQ-003** The eligibility consumer SHALL anchor `eligible_from` to a timestamp read from the `deals` table via JOIN: `deals.updated_at` for `deal.approved`, `deals.auto_complete_after` for `deal.auto_completed`, `deals.resolved_at` for `deal.dispute_resolved`. The consumer SHALL NOT compute `eligible_from = now()` and SHALL NOT depend on outbox payload-side timestamp keys.
- **REQ-004** `eligible_until` SHALL equal `eligible_from + INTERVAL '90 days'`.
- **REQ-005** `POST /reviews` SHALL be permitted only when the caller is a party to the deal, `review_windows.eligible=true`, `now() BETWEEN eligible_from AND eligible_until`, and no prior review exists for `(deal_id, reviewer_role)`.
- **REQ-006** Reviews SHALL be immutable after submission; no PATCH or PUT endpoint is exposed. The `reviews.comment` field is editable only by the GDPR erasure handler (REQ-031).
- **REQ-007** Client reviews SHALL require `overall_rating` plus all three sub-criteria (`quality_rating`, `communication_rating`, `timeliness_rating`), each in `[1, 5]`. Provider reviews SHALL carry `overall_rating` only; sub-criteria columns SHALL be NULL.
- **REQ-008** A submitted review SHALL be created with `status='pending'` and `revealed_at=NULL`. The blind-reveal sweep SHALL transition it to `status='published'` and set `revealed_at=now()` when any of: (a) `both_submitted=true`, (b) `submitted_at + INTERVAL '14 days' <= now()`, (c) `eligible_until <= now()`.
- **REQ-009** The reveal sweep SHALL run every 60 seconds, use `FOR UPDATE SKIP LOCKED LIMIT 200`, and re-run immediately when the previous batch saturated the LIMIT.
- **REQ-010** The reveal sweep SHALL operate per-row: a 14-day fallback reveals only the submitter's row. The counterparty's row, if absent, never appears; if present and not yet eligible by its own clock, remains hidden until its own condition fires.
- **REQ-011** `both_submitted` SHALL be a column on `reviews` maintained by an `AFTER INSERT OR UPDATE OF status` trigger that updates all rows for the same `deal_id` (DDL §4.1).
- **REQ-012** Each successful review submission SHALL emit `review.submitted` to `outbox_events` in the same transaction.
- **REQ-013** Each transition of `reviews.status` between `pending`, `published`, `hidden`, `removed` SHALL emit `review.status_changed` to `outbox_events` in the same transaction.
- **REQ-014** The aggregation worker SHALL subscribe to `review.submitted` and `review.status_changed`, invoking `compute_listing_rating_aggregate(listing_id)` and `compute_provider_rating_aggregate(provider_id)` as `SECURITY DEFINER` functions.
- **REQ-015** Aggregation SHALL be a full recompute over the current `status='published'` set; deltas SHALL NOT be applied. This guarantees idempotency and correctness under concurrent moderation actions.
- **REQ-016** Aggregation SHALL run in a transaction separate from review INSERT/UPDATE; an aggregation failure SHALL NOT roll back the originating review write.
- **REQ-017** Listing aggregates SHALL include only `reviewer_role='client'` reviews with `status='published'`. Provider profile aggregates SHALL include only `reviewer_role='client'` reviews of the provider with `status='published'`.
- **REQ-018** A reviewee MAY submit one reply per review via `POST /reviews/{review_id}/replies`. The reply body SHALL be 1–2000 characters.
- **REQ-019** Replies SHALL be editable by their author. Each edit SHALL append a row to `review_reply_audit` containing `body_before` and `body_after` in the same transaction as the UPDATE.
- **REQ-020** A DB trigger `deny_reply_edit_before_reveal` SHALL raise on any UPDATE to `review_replies.body` when the parent review's `revealed_at IS NULL`.
- **REQ-021** `POST /reviews/{review_id}/reports` SHALL require the caller to be a qualifying reporter (kyc_approved OR completed_deals_count ≥ 1 OR account_age_days ≥ 7); non-qualifying callers SHALL receive HTTP 403 `reporter_not_qualified`.
- **REQ-022** A qualifying reporter SHALL be limited to 3 review reports per rolling 24 hours (rate limit on top of the qualifying gate).
- **REQ-023** A `(review_id, reporter_id)` pair SHALL be unique; a duplicate report SHALL return HTTP 409 `already_reported`.
- **REQ-024** Review takedown SHALL be admin-only. There is no auto-takedown at any report count.
- **REQ-025** Admins SHALL transition reviews via `POST /admin/reviews/{id}/hide`, `POST /admin/reviews/{id}/remove`, `POST /admin/reviews/{id}/restore`. Each transition emits `review.status_changed`.
- **REQ-026** A daily retention sweep SHALL delete `review_reports` rows older than 12 months that are either resolved with `resolution='dismissed'` or orphaned (parent review no longer in `published`).
- **REQ-027** Review attachments SHALL be uploaded via the existing Media Pipeline using the new `purpose='review_attachment'` value and a new `media_objects.review_id` FK column. A maximum of 3 attachments per review SHALL be enforced at `POST /media/uploads/initiate` using the same advisory-lock pattern as listing media (Media Pipeline REQ-014).
- **REQ-028** The Media Pipeline `GET /media/{id}/stream` endpoint, when serving `purpose='review_attachment'`, SHALL apply the authorization rule: author always streams; reviewee streams iff parent review's `revealed_at IS NOT NULL AND status='published'`; admin always streams; otherwise return 404 (identical to non-existence per Media Pipeline SEC-003).
- **REQ-029** `reviews` SHALL have Row-Level Security ENABLED and FORCED. The default policy `reviews_visibility` SHALL permit a row visible to a non-admin caller iff `reviewer_id = current_setting('app.current_user_id')::uuid` OR `(revealed_at IS NOT NULL AND status='published')`.
- **REQ-030** The aggregation worker SHALL invoke `compute_listing_rating_aggregate` and `compute_provider_rating_aggregate` via `SECURITY DEFINER` functions owned by a privileged no-login role. The worker's own DB role SHALL NOT be granted `BYPASSRLS`.
- **REQ-031** On user GDPR erasure, in a single transaction the system SHALL: (a) `UPDATE reviews SET reviewer_id=NULL, comment=NULL WHERE reviewer_id=$user`; (b) `UPDATE review_replies SET author_id=NULL WHERE author_id=$user`; (c) `UPDATE review_reply_audit SET edited_by=NULL WHERE edited_by=$user`; (d) emit `user.gdpr_erased_reviews` to the outbox.
- **REQ-032** Reviews authored by an erased user SHALL remain in `status='published'` and continue to count toward aggregates; the public read path SHALL render the author label as "Видалений користувач" / "Deleted user".

### Security requirements

- **SEC-001** Pre-reveal review content SHALL NOT be readable by the counterparty through any code path. Enforcement is at the DB layer via the RLS policy on `reviews` (REQ-029); application-layer checks are defense-in-depth, not the primary control.
- **SEC-002** The `reviews_visibility` RLS policy SHALL be `FORCED` so that table owners do not bypass it. Worker access SHALL be via `SECURITY DEFINER` functions, not via owner role direct queries.
- **SEC-003** Stream authorization for `purpose='review_attachment'` (REQ-028) SHALL return identical 404 responses for both nonexistent media and unauthorized access (alignment with Media Pipeline SEC-003).
- **SEC-004** The qualifying-reporter gate (REQ-021) SHALL be evaluated using the caller's *current* status at report time, not cached at session start; this prevents a freshly-banned reporter from filing reports under stale credentials.
- **SEC-005** The GDPR erasure path (REQ-031) SHALL run as an atomic transaction; partial erasure (e.g., `reviews` cleared but `review_reply_audit` not cleared) SHALL NOT be observable.
- **SEC-006** Admin moderation actions SHALL be auditable via outbox `review.status_changed` events with `from_status`, `to_status`, and the actor's user id in payload.
- **SEC-007** `GET /reviews/{id}` and `POST /reviews/{id}/reports` SHALL return identical 404 responses for both nonexistent reviews and reviews invisible to the caller per RLS.
- **SEC-008** Free-text `comment` and `body` fields SHALL be sanitized for XSS at render time (output escaping); no HTML is permitted.

### Patterns

- **PAT-001** Eligibility-by-DB-join. The eligibility consumer reads timestamps from `deals` columns rather than from outbox payloads, avoiding cross-module payload contracts.
- **PAT-002** Trigger-maintained derived flag. `both_submitted` is maintained by an `AFTER` trigger on `reviews` rather than computed at read time, keeping the reveal sweep predicate simple and indexable.
- **PAT-003** Per-row reveal clock. The 14-day fallback applies to each `reviews` row independently using its own `submitted_at`, not a deal-wide deadline.
- **PAT-004** Async outbox-driven aggregation. Review writes emit events; a separate worker recomputes aggregates from source of truth. Inline synchronous aggregation is forbidden.
- **PAT-005** Full-recompute aggregation. The aggregation worker SELECTs the current `published` set and overwrites the aggregate row. Deltas are not applied.
- **PAT-006** Append-only audit. Reply edits write `body_before`/`body_after` to `review_reply_audit` in the same transaction as the UPDATE; replacement-without-trace is prevented.
- **PAT-007** RLS + `SECURITY DEFINER` split. Read paths run under RLS; aggregation runs in a privilege-scoped function, not under blanket `BYPASSRLS`.
- **PAT-008** Sentinel-NULL erasure. GDPR erasure NULLs FK references and free-text PII; rows are retained for referential integrity. No sentinel UUID seeded.
- **PAT-009** Qualifying-reporter gate before rate limit. Anti-Sybil filtering precedes the per-user rate limit (consistent with Listings SEC-003).
- **PAT-010** Pipeline extension over fork. Review attachments extend `media_objects` with a new `purpose` value and FK column rather than building a parallel storage flow (Media Pipeline GUD-005).

### Constraints

- **CON-001** PostgreSQL 15+ with `pgcrypto` and Row-Level Security; the existing `outbox_events` table from the Deal spec.
- **CON-002** `reviews.comment` length: 20–2000 characters. `review_replies.body` length: 1–2000.
- **CON-003** Rating scales: `overall_rating`, `quality_rating`, `communication_rating`, `timeliness_rating` all `SMALLINT BETWEEN 1 AND 5`.
- **CON-004** Eligibility window: 90 days from anchor; minimum 7 days enforced by CHECK constraint `eligible_until >= eligible_from + INTERVAL '7 days'`.
- **CON-005** Blind-reveal fallback: 14 days per row.
- **CON-006** Reveal sweep batch: `LIMIT 200` per pass; 60-second cadence; immediate re-run on saturation.
- **CON-007** Maximum review attachments: 3 per review. Max attachment size and MIME types: as Media Pipeline `listing_attachment` (10 MB; `image/jpeg`, `image/png`, `image/webp`).
- **CON-008** Report rate limit: 3 reports per qualifying reporter per rolling 24 hours, per `(reporter_id)`.
- **CON-009** Retention: dismissed/orphaned `review_reports` purged after 12 months; `review_reply_audit` retained for the lifetime of the parent review (cascaded on review delete).
- **CON-010** Moderation SLA target: 5 business days for unresolved reports. Alert: `unresolved_count > 500` for 10 minutes → P3 PagerDuty.
- **CON-011** The aggregation worker's role SHALL NOT have `BYPASSRLS` set as a role attribute. Only `EXECUTE` on the `SECURITY DEFINER` aggregation functions.
- **CON-012** No notification transport is implemented in this module; events are emitted to the outbox only.

### Guidelines

- **GUD-001** Prefer outbox events for cross-module reactions (e.g., Notifications consumes `review.submitted`, `review.published`, `review.replied`). Direct DB joins from other modules into `reviews` SHALL go through `reviews_visible` view (defined in §4.1) under the standard application role.
- **GUD-002** When listing or provider review counts exceed ~10k per aggregate target, evaluate switching aggregation from full-recompute to incremental delta plus periodic full-recompute. The current full-recompute scales adequately at MVP.
- **GUD-003** Sub-criteria averages on `provider_profiles` are denormalized for read performance. Schema additions for new sub-criteria require coordinated migrations and a corresponding `compute_provider_rating_aggregate` revision.
- **GUD-004** Future modules adding a new `media_objects.purpose` SHALL follow the migration pattern in §4.5 (ADD constraint NOT VALID → VALIDATE → DROP old → RENAME), never DROP-then-ADD.
- **GUD-005** The Notifications module SHOULD apply per-event coalescing for `review.submitted` / `review.published` so a counterparty does not receive two messages in quick succession when a reveal fires shortly after submission.

## 4. Interfaces & Data Contracts

### 4.1 `reviews` (canonical)

```sql
CREATE TABLE reviews (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  deal_id                UUID         NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
  listing_id             UUID         REFERENCES listings(id) ON DELETE SET NULL,

  reviewer_id            UUID         REFERENCES users(id) ON DELETE SET NULL,
    -- NULL after GDPR erasure (REQ-031). Public render: "Deleted user".
  reviewee_id            UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_role          TEXT         NOT NULL CHECK (reviewer_role IN ('client','provider')),

  overall_rating         SMALLINT     NOT NULL,
  quality_rating         SMALLINT,
  communication_rating   SMALLINT,
  timeliness_rating      SMALLINT,

  comment                TEXT,
    -- NULL only after GDPR erasure; live rows enforce the length CHECK below.
  status                 TEXT         NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','published','hidden','removed')),

  both_submitted         BOOLEAN      NOT NULL DEFAULT false,
    -- Maintained by trg_reviews_both_submitted (§4.1.1).

  submitted_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  revealed_at            TIMESTAMPTZ,

  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_review_deal_role UNIQUE (deal_id, reviewer_role),

  CONSTRAINT chk_reviewer_ne_reviewee
    CHECK (reviewer_id IS NULL OR reviewer_id <> reviewee_id),

  CONSTRAINT chk_comment_length
    CHECK (
      comment IS NULL
      OR char_length(comment) BETWEEN 20 AND 2000
    ),

  CONSTRAINT chk_rating_fields CHECK (
    overall_rating BETWEEN 1 AND 5
    AND CASE reviewer_role
      WHEN 'client' THEN
        quality_rating       BETWEEN 1 AND 5
        AND communication_rating BETWEEN 1 AND 5
        AND timeliness_rating    BETWEEN 1 AND 5
      WHEN 'provider' THEN
        quality_rating       IS NULL
        AND communication_rating IS NULL
        AND timeliness_rating    IS NULL
      ELSE false
    END
  ),

  CONSTRAINT chk_revealed_only_when_published
    CHECK (revealed_at IS NULL OR status IN ('published','hidden','removed'))
);

CREATE INDEX idx_reviews_listing_published
  ON reviews (listing_id, revealed_at DESC)
  WHERE status = 'published' AND reviewer_role = 'client';

CREATE INDEX idx_reviews_reviewee_published
  ON reviews (reviewee_id, revealed_at DESC)
  WHERE status = 'published';

CREATE INDEX idx_reviews_reveal_sweep
  ON reviews (submitted_at)
  WHERE status = 'pending';

CREATE INDEX idx_reviews_deal
  ON reviews (deal_id);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY reviews_visibility ON reviews
  USING (
    reviewer_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR (revealed_at IS NOT NULL AND status = 'published')
  );

-- Read-path helper view (recommended for cross-module joins).
CREATE VIEW reviews_visible AS
  SELECT * FROM reviews
  WHERE status = 'published' AND revealed_at IS NOT NULL;
```

### 4.1.1 `both_submitted` trigger

```sql
CREATE OR REPLACE FUNCTION trg_set_both_submitted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_client_done   BOOLEAN;
  v_provider_done BOOLEAN;
BEGIN
  SELECT
    EXISTS(SELECT 1 FROM reviews
           WHERE deal_id = NEW.deal_id AND reviewer_role = 'client'
             AND status = 'published'),
    EXISTS(SELECT 1 FROM reviews
           WHERE deal_id = NEW.deal_id AND reviewer_role = 'provider'
             AND status = 'published')
  INTO v_client_done, v_provider_done;

  UPDATE reviews
     SET both_submitted = (v_client_done AND v_provider_done)
   WHERE deal_id = NEW.deal_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reviews_both_submitted
  AFTER INSERT OR UPDATE OF status ON reviews
  FOR EACH ROW EXECUTE FUNCTION trg_set_both_submitted();
```

### 4.2 `review_windows`

```sql
CREATE TABLE review_windows (
  deal_id               UUID         PRIMARY KEY REFERENCES deals(id) ON DELETE RESTRICT,
  client_id             UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id           UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  eligible_from         TIMESTAMPTZ  NOT NULL,
  eligible_until        TIMESTAMPTZ  NOT NULL,

  eligible              BOOLEAN      NOT NULL DEFAULT true,
  ineligibility_reason  TEXT,

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT chk_window_floor
    CHECK (eligible_until > eligible_from
           AND eligible_until >= eligible_from + INTERVAL '7 days'),

  CONSTRAINT chk_ineligibility_reason
    CHECK (
      (eligible = true  AND ineligibility_reason IS NULL)
      OR
      (eligible = false AND ineligibility_reason IS NOT NULL)
    )
);

CREATE INDEX idx_review_windows_until
  ON review_windows (eligible_until)
  WHERE eligible = true;
```

### 4.3 `review_replies` and `review_reply_audit`

```sql
CREATE TABLE review_replies (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id    UUID         NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
  author_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    -- NULL after GDPR erasure (REQ-031).
  body         TEXT         NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status       TEXT         NOT NULL DEFAULT 'published'
                  CHECK (status IN ('published','hidden')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_one_reply_per_review UNIQUE (review_id)
);

CREATE INDEX idx_review_replies_review ON review_replies (review_id);
CREATE INDEX idx_review_replies_author ON review_replies (author_id);

CREATE TABLE review_reply_audit (
  id           BIGSERIAL    PRIMARY KEY,
  reply_id     UUID         NOT NULL REFERENCES review_replies(id) ON DELETE CASCADE,
  edited_by    UUID         REFERENCES users(id) ON DELETE SET NULL,
  body_before  TEXT         NOT NULL,
  body_after   TEXT         NOT NULL,
  edited_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_reply_audit_reply ON review_reply_audit (reply_id, edited_at DESC);

-- Block reply edits before the parent review is revealed.
CREATE OR REPLACE FUNCTION trg_deny_reply_edit_before_reveal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_revealed_at TIMESTAMPTZ;
BEGIN
  SELECT revealed_at INTO v_revealed_at
    FROM reviews WHERE id = NEW.review_id;

  IF v_revealed_at IS NULL THEN
    RAISE EXCEPTION 'reply cannot be created or edited before review is revealed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deny_reply_edit_before_reveal
  BEFORE INSERT OR UPDATE OF body ON review_replies
  FOR EACH ROW EXECUTE FUNCTION trg_deny_reply_edit_before_reveal();
```

### 4.4 `review_reports`

```sql
CREATE TABLE review_reports (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id     UUID         NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id   UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason        TEXT         NOT NULL
                   CHECK (reason IN ('spam','fake','offensive','irrelevant','other')),
  description   TEXT         CHECK (description IS NULL OR char_length(description) <= 500),
  status        TEXT         NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','reviewed','dismissed')),
  resolution    TEXT         CHECK (resolution IN ('hide','remove','dismissed') OR resolution IS NULL),
  resolved_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_report_per_reporter UNIQUE (review_id, reporter_id)
);

CREATE INDEX idx_review_reports_pending
  ON review_reports (created_at)
  WHERE status = 'pending';
```

### 4.5 Migration: `media_objects.review_id` and extended `chk_exactly_one_owner`

```sql
-- Step 1: ADD column nullable, no constraint impact.
ALTER TABLE media_objects
  ADD COLUMN review_id UUID REFERENCES reviews(id) ON DELETE SET NULL;

-- Step 2: ADD purpose value to the enum CHECK (brief ACCESS EXCLUSIVE; small).
ALTER TABLE media_objects DROP CONSTRAINT media_objects_purpose_check;
ALTER TABLE media_objects ADD CONSTRAINT media_objects_purpose_check
  CHECK (purpose IN ('listing_cover','listing_gallery','listing_attachment',
                     'kyc_document','avatar','review_attachment'));

-- Step 3: ADD new exactly-one-owner constraint NOT VALID (no scan).
ALTER TABLE media_objects
  ADD CONSTRAINT chk_exactly_one_owner_v2 CHECK (
    ((owner_user_id   IS NOT NULL)::int +
     (listing_id      IS NOT NULL)::int +
     (kyc_document_id IS NOT NULL)::int +
     (review_id       IS NOT NULL)::int) = 1
  ) NOT VALID;

-- Step 4: VALIDATE (online; ShareUpdateExclusiveLock).
ALTER TABLE media_objects VALIDATE CONSTRAINT chk_exactly_one_owner_v2;

-- Step 5: DROP old constraint after new one is live and validated.
ALTER TABLE media_objects DROP CONSTRAINT chk_exactly_one_owner;

-- Step 6: RENAME to canonical name.
ALTER TABLE media_objects
  RENAME CONSTRAINT chk_exactly_one_owner_v2 TO chk_exactly_one_owner;
```

This ordering guarantees that no transient state exists in which `media_objects` lacks a one-owner constraint.

### 4.6 Aggregates and `SECURITY DEFINER` aggregation functions

```sql
ALTER TABLE listings
  ADD COLUMN avg_rating   NUMERIC(3,2),
  ADD COLUMN review_count INT NOT NULL DEFAULT 0;

ALTER TABLE provider_profiles
  ADD COLUMN avg_rating          NUMERIC(3,2),
  ADD COLUMN avg_quality         NUMERIC(3,2),
  ADD COLUMN avg_communication   NUMERIC(3,2),
  ADD COLUMN avg_timeliness      NUMERIC(3,2),
  ADD COLUMN review_count        INT NOT NULL DEFAULT 0;

CREATE ROLE aggregation_owner NOLOGIN;
CREATE ROLE review_aggregation_worker LOGIN PASSWORD '<vault>';

CREATE OR REPLACE FUNCTION compute_listing_rating_aggregate(p_listing_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE listings
     SET avg_rating   = sub.avg_rating,
         review_count = sub.review_count
    FROM (
      SELECT
        ROUND(AVG(overall_rating)::numeric, 2) AS avg_rating,
        COUNT(*)                                AS review_count
      FROM reviews
      WHERE listing_id     = p_listing_id
        AND reviewer_role  = 'client'
        AND status         = 'published'
    ) sub
   WHERE id = p_listing_id;
END;
$$;
ALTER FUNCTION compute_listing_rating_aggregate(UUID) OWNER TO aggregation_owner;
GRANT EXECUTE ON FUNCTION compute_listing_rating_aggregate(UUID)
  TO review_aggregation_worker;

CREATE OR REPLACE FUNCTION compute_provider_rating_aggregate(p_provider_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE provider_profiles
     SET avg_rating         = sub.avg_overall,
         avg_quality        = sub.avg_quality,
         avg_communication  = sub.avg_communication,
         avg_timeliness     = sub.avg_timeliness,
         review_count       = sub.review_count
    FROM (
      SELECT
        ROUND(AVG(overall_rating)::numeric, 2)        AS avg_overall,
        ROUND(AVG(quality_rating)::numeric, 2)        AS avg_quality,
        ROUND(AVG(communication_rating)::numeric, 2)  AS avg_communication,
        ROUND(AVG(timeliness_rating)::numeric, 2)     AS avg_timeliness,
        COUNT(*)                                       AS review_count
      FROM reviews
      WHERE reviewee_id    = p_provider_id
        AND reviewer_role  = 'client'
        AND status         = 'published'
    ) sub
   WHERE user_id = p_provider_id;
END;
$$;
ALTER FUNCTION compute_provider_rating_aggregate(UUID) OWNER TO aggregation_owner;
GRANT EXECUTE ON FUNCTION compute_provider_rating_aggregate(UUID)
  TO review_aggregation_worker;
```

The worker role connects to the database with a non-`BYPASSRLS` user. RLS on `reviews` permits no read for it under the default policy — and that is fine, because the aggregation work happens inside the `SECURITY DEFINER` functions which run as `aggregation_owner` (which itself is granted `BYPASSRLS` on `reviews` *or* the policy grants it via a dedicated `USING` clause). Worker queries outside these functions see only what RLS permits.

### 4.7 Reveal sweep (pseudocode)

```sql
-- Run every 60s. After processing, if rows_locked == 200, re-run immediately.
WITH due AS (
  SELECT id
    FROM reviews
   WHERE status = 'pending'
     AND (
       both_submitted = true
       OR submitted_at + INTERVAL '14 days' <= now()
       OR EXISTS (
         SELECT 1 FROM review_windows rw
          WHERE rw.deal_id = reviews.deal_id
            AND rw.eligible_until <= now()
       )
     )
   ORDER BY submitted_at
   FOR UPDATE SKIP LOCKED
   LIMIT 200
)
UPDATE reviews r
   SET status      = 'published',
       revealed_at = now(),
       updated_at  = now()
  FROM due
 WHERE r.id = due.id
   AND r.status = 'pending';
-- Each row that transitions to 'published' fires trg_reviews_both_submitted
-- and is emitted as 'review.status_changed' from the application code that wraps this UPDATE.
```

### 4.8 Outbox event registry

| Event | Emitted by | Payload keys |
|---|---|---|
| `review.submitted` | `POST /reviews` handler | `review_id, deal_id, listing_id, reviewer_role, reviewee_id` |
| `review.status_changed` | reveal sweep, admin moderation, reply moderation | `review_id, listing_id, reviewee_id, from_status, to_status, actor_id` (actor_id NULL for sweep) |
| `review.replied` | `POST /reviews/{id}/replies` | `review_id, reply_id, author_id` |
| `review.reported` | `POST /reviews/{id}/reports` | `review_id, report_id, reporter_id, reason` |
| `user.gdpr_erased_reviews` | erasure handler | `user_id, erased_at` |

### 4.9 REST API surface

| Method | Path | Auth | Summary |
|---|---|---|---|
| `POST` | `/reviews` | client or provider party | Submit review for a deal |
| `GET` | `/reviews/{id}` | any | Fetch single review (RLS-gated) |
| `GET` | `/reviews?listing_id=&reviewee_id=&cursor=` | any | List published reviews |
| `POST` | `/reviews/{id}/replies` | reviewee | Create reply |
| `PATCH` | `/reviews/{id}/replies/{reply_id}` | reply author | Edit reply (audited) |
| `POST` | `/reviews/{id}/reports` | qualifying reporter | Report review |
| `GET` | `/admin/reviews?status=&listing_id=` | admin | Moderation list |
| `POST` | `/admin/reviews/{id}/hide` | admin | Hide review |
| `POST` | `/admin/reviews/{id}/remove` | admin | Remove review |
| `POST` | `/admin/reviews/{id}/restore` | admin | Restore to published |
| `GET` | `/admin/reviews/reports?status=pending` | admin | Report queue |
| `POST` | `/admin/reviews/reports/{report_id}/resolve` | admin | Resolve report |

#### `POST /reviews`

```http
POST /api/v1/reviews
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "deal_id": "uuid",
  "overall_rating": 5,
  "quality_rating": 5,
  "communication_rating": 4,
  "timeliness_rating": 5,
  "comment": "Робота виконана якісно та вчасно.",
  "attachment_media_ids": ["uuid1"]
}
```

Responses:
- `201 Created` — review created, `status='pending'`, `revealed_at=null`.
- `403 Forbidden` `{"error":"deal_not_eligible"}` — window closed, suppressed by `dispute_unresolved`, or caller not a party.
- `409 Conflict` `{"error":"already_reviewed"}` — duplicate `(deal_id, reviewer_role)`.
- `422 Unprocessable Entity` — rating range, comment length, sub-criteria role mismatch.

#### `GET /reviews?listing_id=...`

Returns rows from `reviews_visible` (RLS-enforced equivalent), cursor-paginated `(revealed_at DESC, id)`. Authors of pre-reveal rows additionally see their own rows by virtue of the RLS policy.

#### `POST /reviews/{id}/reports`

```http
POST /api/v1/reviews/{id}/reports
{
  "reason": "fake",
  "description": "Reviewer never participated in the deal."
}
```

Responses:
- `202 Accepted`
- `403 Forbidden` `{"error":"reporter_not_qualified"}` — caller fails qualifying gate.
- `409 Conflict` `{"error":"already_reported"}`
- `429 Too Many Requests` — rate limit (3/24h).

## 5. Acceptance Criteria

- **AC-001** Given a deal transitions to `completed` via Client `/approve`, when the Reviews consumer processes `deal.approved`, then a `review_windows` row exists with `eligible_from = deals.updated_at` and `eligible_until = eligible_from + 90d`.
- **AC-002** Given `deal.dispute_resolved` with `outcome=refund_to_client`, when the consumer processes the event, then no `review_windows` row is created.
- **AC-003** Given an existing `review_windows` row, when `deal.dispute_unresolved` arrives, then the row's `eligible` becomes `false` with `ineligibility_reason='dispute_unresolved_refund_to_client'` and subsequent `POST /reviews` returns 403.
- **AC-004** Given the same outbox event is delivered twice, when the consumer processes both, then exactly one `review_windows` row exists (idempotent `ON CONFLICT DO NOTHING`).
- **AC-005** Given a Client review with NULL `quality_rating`, when INSERT is attempted, then the DB rejects via `chk_rating_fields`.
- **AC-006** Given a Provider review with non-NULL `quality_rating`, when INSERT is attempted, then the DB rejects via `chk_rating_fields`.
- **AC-007** Given a review submitted alone, when 14 days elapse, then the reveal sweep transitions only that row to `published`; the counterparty's row, if absent, is not synthesized.
- **AC-008** Given both parties submit, when the second submission's status transition fires `trg_reviews_both_submitted`, then both rows have `both_submitted=true` and the next sweep pass reveals both.
- **AC-009** Given a `published` review on a listing, when an admin hides it, then within one aggregation worker cycle the listing's `avg_rating` and `review_count` exclude that review.
- **AC-010** Given an aggregation worker DB error, when it fails after the review INSERT commits, then the review remains in `published` (or `pending`) and the originating client request is unaffected; the next event delivery retries aggregation.
- **AC-011** Given a non-author non-admin caller, when they `GET /reviews/{id}` for a `pending` review, then the response is 404 (RLS hides the row).
- **AC-012** Given a reviewee, when they `POST /reviews/{id}/replies` before reveal, then the trigger raises `P0001` and the API returns 409.
- **AC-013** Given an existing reply, when the author PATCHes its body, then `review_reply_audit` gains a row with the prior body, in the same transaction.
- **AC-014** Given a non-qualifying reporter (account 3 days old, no completed deal, no KYC), when they `POST /reviews/{id}/reports`, then the response is 403 `reporter_not_qualified`.
- **AC-015** Given a qualifying reporter, when they file their 4th report in 24h, then the response is 429.
- **AC-016** Given a user erasure request, when the erasure handler runs, then `reviews.reviewer_id`, `reviews.comment`, `review_replies.author_id`, and `review_reply_audit.edited_by` referencing the user are all NULL after a single transaction commit.
- **AC-017** Given an erased reviewer's review, when a public consumer fetches it, then the row is still returned with author label "Видалений користувач" and the row continues to count toward aggregates.
- **AC-018** Given the reveal sweep batch saturates `LIMIT 200`, when the worker observes saturation, then it re-runs immediately rather than waiting for the next 60s tick.
- **AC-019** Given a review attachment with `purpose='review_attachment'`, when the reviewee streams it before reveal, then `GET /media/{id}/stream` returns 404.
- **AC-020** Given the migration in §4.5, when migration steps execute in order on a non-empty `media_objects`, then at no intermediate step do live writes succeed without exactly-one-owner enforcement.

## 6. Test Automation Strategy

- **Test levels**: Unit (validators, qualifying-reporter logic), Integration (eligibility consumer against pgmq + outbox; reveal sweep against seeded `reviews`; aggregation worker), E2E (full deal → completion → review submission → reveal → public read paths).
- **Frameworks**: Project standard — Jest/Vitest for TS services, pytest+SQLAlchemy for any Python workers; testcontainers with Postgres 15 for integration tests against real DDL and triggers.
- **Test data**: Each suite creates a fresh schema per worker; helper factories for Deals in each terminal state; dedicated fixtures for sub-criteria validation.
- **CI/CD integration**: Migrations applied to ephemeral DB on every PR; constraint and trigger behaviors tested explicitly (negative tests for `chk_rating_fields`, `deny_reply_edit_before_reveal`, `chk_window_floor`).
- **Coverage**: ≥85% on aggregation function, eligibility consumer, reveal sweep, and erasure handler.
- **Performance**: Reveal sweep benchmark on 100k pending rows (target: full sweep under 60s wall clock at 200/batch); aggregation worker benchmark on listing with 10k reviews (target: < 250 ms per recompute).

## 7. Rationale & Context

The Reviews module is the reputation surface of the marketplace; every decision below trades sharpness against abuse-resistance.

**Eligibility through Deal events.** The Deal module already owns the canonical state machine and emits outbox events on terminal transitions. The Reviews consumer subscribes rather than polling `deals.status`, keeping cross-module coupling unidirectional. Reading anchor timestamps from `deals` columns rather than payload keys (D-CF-1) avoids requiring a Deal spec amendment for payload contract additions.

**Two value-exchange outcomes generate eligibility.** `release_to_provider` and `split` represent an actual service outcome the parties are positioned to evaluate. `refund_to_client` and the SLA-auto-cancel `dispute_unresolved` semantically mean "the platform could not affirm value was delivered"; allowing reviews here invites retaliatory ratings on contested deals.

**Asymmetric sub-criteria.** Client→Provider sub-criteria (quality, communication, timeliness) are meaningful evaluations of service delivery. Provider→Client sub-criteria are not a marketplace concept worth defining; the asymmetric CHECK encodes intent at the DB layer and prevents accidental UI parity.

**Mandatory `overall_rating` for both roles.** Aggregation depends on `AVG(overall_rating)`; allowing NULL would silently shrink denominators. The constraint enforces presence at the DB layer regardless of API conformance.

**Blind reveal with per-row 14-day fallback.** Simultaneous reveal once both submit eliminates the trivial retaliation vector (read counterparty, then craft response). The per-row 14-day fallback is the right semantic for asymmetric submission: a Client who reviewed early should not wait 90 days to be heard. Revealing only the submitter's own row (option a) avoids manufacturing visibility for a row that does not exist.

**Trigger-maintained `both_submitted`.** A generated column cannot reference other rows in the same table; a trigger updating sibling rows is the correct PostgreSQL mechanism. Computing `both_submitted` at sweep time would require a self-join in the WHERE clause and prevent a partial index.

**Async outbox aggregation, full recompute.** Synchronous inline aggregation serializes all reviews for popular listings on the same `listings` row lock — a textbook hot-partition bottleneck. Async + full-recompute is idempotent under concurrent moderation actions (no lost updates) and tolerates worker restarts. The cost is sub-second staleness, acceptable for a reputation surface.

**`SECURITY DEFINER` over `BYPASSRLS`.** Granting `BYPASSRLS` to a long-lived worker connection bypasses RLS on every table the role touches, not just `reviews`. Encapsulating aggregation in a `SECURITY DEFINER` function owned by a privileged, no-login role bounds the privilege to the function body.

**RLS on `reviews`.** App-layer-only enforcement of pre-reveal invisibility is an IDOR risk in any future code path that reads `reviews` without re-implementing the guard. RLS makes the gate part of the schema; secondary code paths inherit it for free.

**One reply per review, append-only audit.** Replaceable replies without an audit trail enable silent retraction of statements that may carry legal weight. Append-only audit preserves the record without forbidding edits.

**Qualifying reporter gate.** A flat per-user rate limit is trivially defeated by Sybil accounts — and account creation is pre-KYC. The qualifying gate reuses the Listings SEC-003 pattern verbatim so callers and operators have one definition to learn.

**Migration order for `chk_exactly_one_owner`.** ADD-NOT VALID → VALIDATE → DROP-OLD avoids any window in which `media_objects` lacks a one-owner constraint. The naive DROP-then-ADD would let an unconstrained insert slip through during a partial migration.

**GDPR: NULL-and-retain rather than delete.** Deleting reviews on author erasure would destabilize aggregates and rewrite reputation history retroactively. NULLing the FK reference and the free-text PII satisfies the erasure right without destroying the platform's collective reputation record. A sentinel UUID was considered and rejected — `ON DELETE SET NULL` plus a public-render label achieves the same outcome with one fewer seeded row.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001** Deal Workflow module — produces `deal.approved`, `deal.auto_completed`, `deal.dispute_resolved`, `deal.dispute_unresolved` outbox events; exposes `deals.updated_at`, `deals.auto_complete_after`, `deals.resolved_at` as anchor columns.
- **EXT-002** Listings module — owns `listings` table; this module adds `avg_rating` and `review_count` columns and writes them via the aggregation worker.
- **EXT-003** Media Pipeline — provides upload/scan/stream for `purpose='review_attachment'`; this module supplies the migration in §4.5 and the authorization rule in REQ-028.
- **EXT-004** Users / Auth — provides `users` table, GDPR erasure orchestration, `provider_profiles`. This module is a downstream of the erasure orchestrator.

### Third-Party Services
- **SVC-001** Object storage (S3-compatible) — accessed transitively via the Media Pipeline; no direct dependency from the Reviews module.

### Infrastructure Dependencies
- **INF-001** PostgreSQL 15+ with RLS, triggers, and `SECURITY DEFINER` functions enabled.
- **INF-002** Outbox worker infrastructure (existing `outbox_events` table + dispatcher) — Reviews adds event types but introduces no new transport.
- **INF-003** PagerDuty (or equivalent) for the unresolved-reports alert (CON-010).

### Data Dependencies
- **DAT-001** `deals` table read access for the eligibility consumer — JOIN on `deals.id` to read anchor timestamps.

### Technology Platform Dependencies
- **PLT-001** Standard project stack (PostgreSQL 15, application runtime as per the rest of the platform); no platform-specific additions.

### Compliance Dependencies
- **COM-001** GDPR / ЗУ "Про захист персональних даних" — right to erasure satisfied by REQ-031.
- **COM-002** Intermediary-liability content moderation — admin-only takedown path with audit trail (`review.status_changed`) and 5-business-day SLA target.

## 9. Examples & Edge Cases

### Example 1 — Both parties submit; reveal happens at second submission

```text
T+0   deal.approved → review_windows row inserted, eligible_from = deals.updated_at.
T+1d  Client submits review → status=pending, both_submitted=false.
T+3d  Provider submits review → trigger sets both_submitted=true on both rows.
T+3d+60s  Reveal sweep transitions both to published, sets revealed_at=now().
            Emits two review.status_changed events.
            Aggregation worker recomputes listing + provider aggregates.
```

### Example 2 — Asymmetric submission; 14-day fallback reveals only the submitter

```text
T+0   deal.auto_completed → review_windows row inserted.
T+2d  Client submits review.
T+16d (=2d+14d) Reveal sweep transitions only the Client row to published.
                Provider has not submitted; no Provider row exists.
T+90d Eligible window closes; Provider can no longer submit.
```

### Example 3 — Dispute resolved with `release_to_provider` after `in_review → disputed`

```text
T+0    deal.dispute_resolved with outcome=release_to_provider.
       Consumer reads deals.resolved_at → review_windows row inserted.
       Both parties may submit reviews.
```

### Example 4 — Bad-faith dispute that auto-cancels

```text
T+0    Client opens dispute.
T+5d   Admin SLA misses.
T+5d+24h Re-escalation; second admin SLA miss.
       deal.dispute_unresolved emitted; deal cancelled with refund-to-client.
       If review_windows row was created earlier (it was not, because no value-exchange
       outcome preceded), it would now be set eligible=false. In this trace the row was
       never created; no review is submittable.
```

### Example 5 — GDPR erasure of a Client who left a 5-star review

```sql
BEGIN;
  UPDATE reviews
     SET reviewer_id = NULL, comment = NULL
   WHERE reviewer_id = '<erased_uuid>';
  UPDATE review_replies
     SET author_id = NULL
   WHERE author_id = '<erased_uuid>';
  UPDATE review_reply_audit
     SET edited_by = NULL
   WHERE edited_by = '<erased_uuid>';
  INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('user', '<erased_uuid>', 'user.gdpr_erased_reviews',
               jsonb_build_object('user_id','<erased_uuid>','erased_at', now()));
COMMIT;
-- The 5-star rating still counts toward aggregates; the row renders as "Deleted user"
-- on the public listing page.
```

### Example 6 — Sybil reporter blocked at the qualifying gate

```text
T+0  Attacker creates 50 fresh accounts.
T+0  Each attempts POST /reviews/{id}/reports.
     account_age_days=0, completed_deals_count=0, kyc_approved=false → 403 reporter_not_qualified.
     No row reaches review_reports; admin queue is unaffected.
```

### Edge case — Slow deal completing on day 95 of contract

```text
The Deal duration is unbounded. eligible_from is anchored to the deal's terminal-state
timestamp, not to deal creation. A deal that finally completes on day 95 of its lifetime
still gets a full 90-day review window starting from the completion timestamp. The
chk_window_floor (eligible_until ≥ eligible_from + 7d) protects against pathological
cases where completion timestamp is malformed.
```

### Edge case — Reveal sweep crashes mid-batch

```text
SKIP LOCKED LIMIT 200 + the per-row idempotent UPDATE means a crashed worker rolls back
its locked rows; the next pass picks them up unchanged. No row is skipped or double-revealed.
```

## 10. Validation Criteria

- All ACs in §5 pass in the integration test suite.
- DB-level CHECK constraints (`chk_rating_fields`, `chk_window_floor`, `chk_revealed_only_when_published`, `chk_ineligibility_reason`, `chk_comment_length`) reject malformed rows in negative tests.
- The trigger `trg_reviews_both_submitted` correctly maintains `both_submitted` under concurrent inserts (verified by repeated submission tests at p99 latency).
- The trigger `deny_reply_edit_before_reveal` raises on pre-reveal reply INSERT/UPDATE; verified for both code paths.
- RLS policy `reviews_visibility` denies pre-reveal access to non-author non-admin callers in a fuzz suite.
- The aggregation worker reproduces correct aggregates from a known seeded fixture under both insertion-only and insertion+hide scenarios.
- The migration in §4.5 applied to a populated test DB never produces a window in which `chk_exactly_one_owner` is absent (verified by a probe-thread test that inserts a two-owner row continuously during migration; expects every insert to fail).
- The eligibility consumer is idempotent under outbox replay (one row per `(deal_id)` after N redeliveries).
- The reveal sweep processes 100k pending rows within 60s at 200/batch in benchmark.
- The GDPR erasure transaction leaves zero remaining references to the erased user across `reviews`, `review_replies`, `review_reply_audit`.
- Public read paths render erased authors as a localized "Deleted user" string; aggregates remain unchanged.
- A non-qualifying reporter consistently receives 403 `reporter_not_qualified` regardless of rate-limit state.

## 11. Related Specifications / Further Reading

- [`spec-architecture-deal-workflow.md`](./spec-architecture-deal-workflow.md) — terminal-state outbox events (`deal.approved`, `deal.auto_completed`, `deal.dispute_resolved`, `deal.dispute_unresolved`) and dispute outcomes consumed for eligibility.
- [`spec-architecture-listings.md`](./spec-architecture-listings.md) — `listings` table; this module adds `avg_rating` and `review_count` columns. Qualifying-reporter pattern (SEC-003) is reused verbatim.
- [`spec-architecture-media-pipeline.md`](./spec-architecture-media-pipeline.md) — extension point for `purpose='review_attachment'`; migration plan for `chk_exactly_one_owner` (§4.5 of this spec).
- [`spec-architecture-users-authentication.md`](./spec-architecture-users-authentication.md) — `users`, `provider_profiles`; GDPR erasure orchestrator that triggers REQ-031.
- [`spec-architecture-kyc-provider-verification.md`](./spec-architecture-kyc-provider-verification.md) — `kyc_approved` flag used by the qualifying-reporter gate.
- [`spec-architecture-marketplace-social-platform.md`](./spec-architecture-marketplace-social-platform.md) — top-level architecture context.
