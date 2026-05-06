# WIP — Module 4: KYC (Provider Verification)

**Status:** IN PROGRESS — critic Round 2 pending (architect refinement done)
**Architect agent ID (R1):** a4c3856b6bc468d42
**Critic agent ID (R1):** aba921577ab724f6e
**Architect agent ID (R2):** a9fd4b2a6ea6e9c5c
**Started:** 2026-05-06

## Scope

Module 4 — KYC for Providers. Gates payout (NOT deal creation, per established project decision). Verifies Provider identity via document submission + admin review.

**Linked modules:**
- Module 1 (Users & Auth) — `users`, `user_roles`, SEC-006 admin re-read.
- Module 2 (Categories) — DONE.
- Module 3 (Deal Workflow) — `deal.escrow_release_requested` event must be gated on `payout_enabled` in Payments consumer (this module owns the flag).

## Project conventions
- PostgreSQL 15+, REST/JSON, UUIDs, money in kopecks, TIMESTAMPTZ UTC.
- Ukrainian context: KYC documents likely passport / ID card / податковий номер (РНОКПП/ІПН) / паспорт громадянина України / закордонний паспорт. ФОП declaration optional.

## Round 1 — architect (verbatim summary)

17 DECISIONs:
- **KYC-01** State machine: `not_submitted → submitted → in_review → approved | rejected | expired` + `claim` step (submitted→in_review) prevents 2-admin race; resubmit allowed from rejected/expired.
- **KYC-02** Required doc set: 1 of {passport_ua | id_card | passport_foreign} + rnokpp + selfie. Optional fop_certificate. Server-side validation 422 `incomplete_document_set`.
- **KYC-03** No 3rd-party vendor at MVP (Diia.ID, OCR, face-match deferred to v2). Manual admin review only. 48-hour SLA target. Schema reserves `automated_check_result JSONB`.
- **KYC-04** App-layer AES-256-GCM encryption (KMS-managed key, INF-003 reused) for `document_number_enc`, `full_name_enc`, `date_of_birth_enc` BYTEA columns. NOT pgcrypto (in-process key co-located with data).
- **KYC-05** `payout_enabled` flip is atomic AND conditional on `users.mfa_enabled`. Single transaction: UPDATE kyc_verifications + UPDATE provider_profiles SET payout_enabled=mfa_enabled + outbox event. CHECK in provider_profiles guards consistency.
- **KYC-06** Payments module reads `provider_profiles.payout_enabled` directly from primary DB at payout time (NO API call to KYC service, NO eventual-consistency cache).
- **KYC-07** Admin claim timeout: 4-hour stale-claim eviction back to `submitted`. Timer sweep + `kyc_review_events` log entry.
- **KYC-08** Expiry: `expires_at = MIN(document_expires_at)` across accepted ID docs (excluding RNOKPP). 30-day pre-expiry warning (rekyc_required); auto-expire at 0d (payout_enabled=false). Annual re-KYC: notification only, no auto-expire. Suspicious activity flag: immediate `payout_enabled=false`.
- **KYC-09** Object store: dedicated bucket, SSE-KMS (separate KMS key from media), no public access, signed-URL TTL 5min admin / 15min provider. File key UUID-based (no PII). Access logging + admin doc_accessed audit row.
- **KYC-10** SEC-006 admin re-read on every admin KYC mutation (claim, approve, reject, suspend, flag-rekyc).
- **KYC-11** `kyc_review_events` append-only via DB privilege (no UPDATE/DELETE grant), not trigger. IP/UA stored on every row; never returned to providers.
- **KYC-12** Retention: approved KYC 5 years post-decision (AML Law); rejected 2 years; `kyc_review_events` never purged. Right-to-erasure exempted by legitimate-interest/legal-obligation; disclosure required in Privacy Policy.
- **KYC-13** Account deleted mid-review: KYC NOT a block on soft-delete (unlike open deals); transitions to new `cancelled` terminal state with `rekyc_required_reason='account_deleted'`. Restore within 90d → `not_submitted`.
- **KYC-14** Two-phase upload: pre-signed PUT URL → client PUT → confirm (HEAD verify) → submission references confirmed upload IDs. 24h orphan sweep.
- **KYC-15** Race: admin claim/approve uses `WHERE version=$v` optimistic lock; provider resubmit increments version → admin's stale approve gets 409 + `kyc_review_events` log of stale-claim attempt.
- **KYC-16** No partial approval. Binary decision (approve all / reject with per-doc reasons via `document_rejections[]`). Per-doc `verification_status` recorded for admin/provider visibility but doesn't drive overall status.
- **KYC-17** Single `kyc_verifications` row per provider (current state); `kyc_documents` carries history via `submission_index`. No separate history table.

**Schema:**
- `kyc_verifications` (UNIQUE on provider_id, status enum, expiry/decision/rekyc fields, version, submission_count)
- `kyc_documents` (BYTEA encrypted PII: doc_number/full_name/dob, plaintext expiry/file_key, doc_type enum, per-doc verification_status, submission_index)
- `kyc_review_events` (append-only audit, IP/UA, admin actor)
- 6 indexes including partial indexes for status queues / expiry sweep / re-kyc due

**API:**
- Provider: GET /kyc/me, POST /kyc/me/submissions, POST /kyc/me/uploads/initiate + /confirm (two-phase), GET /kyc/me/documents/{id}/download-url
- Admin: GET /admin/kyc (queue), GET /admin/kyc/{provider_id}, POST claim/approve/reject/suspend/flag-rekyc, GET admin doc download URL (5min, access-logged)

**Outbox events:** kyc.submitted, kyc.approved, kyc.rejected, kyc.expired, kyc.rekyc_required, kyc.suspended

**Out of scope:** Diia.ID/OCR/face-match (v2), FOP business-registry validation, AML monitoring (manual trigger only), four-eyes review (schema future-compat), liveness video, client-side KYC, country-specific non-UA validation, notification delivery, admin UI.

## Round 1 — critic verdict: REJECT (20 risks)

**BLOCKERS:**
- **RISK-05** Payout MFA cross-table gap. Auth's CHECK only guards kyc_status; no DB constraint prevents `payout_enabled=true AND mfa_enabled=false`. Any direct DB write or future bug in MFA-disable handler bypasses runtime check. Need DB-level guard (trigger on provider_profiles + users.mfa_enabled, or computed/view column).
- **RISK-06** `provider_profiles.kyc_status` denormalization sync gap. Auth spec defines it as a denormalized copy of kyc_verifications.status (different enum sets). Proposal says single tx but doesn't pin both tables in same DB; partial failure leaves divergence. Need explicit "both tables same DB, single tx" + reconciliation alert for `kyc_verifications.status='approved' AND payout_enabled=false AND mfa_enabled=true` >5min.
- **RISK-09** `expires_at = MIN(document_expires_at)` across ALL kyc_documents rows (not scoped to current approved submission_index) → false-positive expiry for proactively-renewed documents. Need scoped MIN: `WHERE submission_index = current AND verification_status='accepted'`.
- **RISK-15** ON DELETE behavior on `kyc_verifications.provider_id` and `provider_profiles.provider_id` not specified. Auth spec's 90d hard-purge will silently fail (FK RESTRICT default). Need explicit ON DELETE SET NULL on tombstone path OR pre-purge KYC step OR document the cascade rule.
- **RISK-13/19** AML retention legal-basis assertion is inconsistent: claim 5-year AML retention but zero sanctions screening = false legal-basis claim. Either (a) implement basic sanctions screening (РНБО/ЕС/OFAC) at admin review with manual lookup button, or (b) revise retention rationale from "AML obligation" to "civil dispute statute of limitations 3y" + reduce raw-doc retention period for rejected KYC (proportionality under ЗУ Про захист персональних даних).
- **RISK-18** RNOKPP format/checksum validation absent. 10-digit + checksum algorithm; trivial server-side validation. Without it forged numbers pass visual review. Add at submission time (422 `invalid_rnokpp`). Distinguish паспорт-книжечка (8-digit + series) vs ID-card (9-digit biometric) format validation too.

**REFINEMENT-LEVEL:**
- **RISK-01** Stale-claim eviction sweep must include `AND status='in_review'` + version increment (PAT-002 pattern from Module 3).
- **RISK-02** Resubmit must atomically: clear `reviewed_by=NULL`, `review_started_at=NULL`, transition to submitted, increment version. Partial index for clean queue should be `WHERE status='submitted' AND reviewed_by IS NULL`.
- **RISK-03** KMS key rotation: store key version identifier on encrypted rows; background re-encryption job after rotation.
- **RISK-04** KMS availability: data-key caching (AWS Encryption SDK pattern) for admin session duration; KMS-degraded mode runbook.
- **RISK-07** Admin queue monopolization: per-admin claim cap (5–10); 429 if exceeded; alert on >threshold concurrent claims.
- **RISK-08** Resubmit cooling-off: 24h after rejection before next submit accepted; lifetime cap (5) → manual admin unblock.
- **RISK-10** Auto-expire defense-in-depth: Payments gate also checks `expires_at IS NULL OR expires_at > now()` at read time, not relying solely on sweep.
- **RISK-11** UUID v4 (random) for file_keys (not v1/v7). Bucket access logs are PII; document legal basis + retention separately.
- **RISK-12** Reduce provider signed-URL TTL from 15min → 5min (consistent with admin); or proxy through app tier.
- **RISK-14** `kyc_review_events` partition by month (consistent with `audit_events` from Auth spec).
- **RISK-16** Mandatory blocking HEAD verify in confirm handler; bucket NOT to have cross-region replication; 409 on HEAD non-200.
- **RISK-17** Quarantine prefix for unconfirmed uploads + 2h bucket lifecycle delete (not 24h). Confirm handler copies to permanent prefix.
- **RISK-20** KMS DR: key backup policy (AWS-managed OR offline key material backup in HSM); CloudWatch alarm on key state changes; same account/region for KMS + bucket.

## Round 2 — architect refinement (verbatim summary)

**BLOCKING resolutions:**
- **KYC-05-R2** Two PostgreSQL triggers (BEFORE INSERT/UPDATE on provider_profiles + BEFORE UPDATE on users) enforce `payout_enabled=true ⟺ mfa_enabled=true` at DB level. CHECK on provider_profiles retained as redundant guard. Cannot be bypassed without two-step attack on both triggers.
- **KYC-06-R2** Same-DB requirement asserted. Enum mapping table (kyc_verifications.status → provider_profiles.kyc_status). Single-tx mutation pattern (BEGIN: UPDATE kv + UPDATE pp + INSERT outbox + COMMIT). Reconciliation alert query every 5min → P2 PagerDuty.
- **KYC-09-R2** `expires_at` scoped to current `submission_index` AND `verification_status='accepted'` AND not RNOKPP AND not NULL. Explicit SQL provided.
- **KYC-13-R2** Path (b) chosen: drop AML claim. Retention based on ЦК України ст. 257 (3y civil-law statute of limitations). Approved KYC: raw docs purged 3y after decision; metadata retained 7y. Rejected: raw docs 90d; metadata 3y. `kyc_review_events` never purged. Sanctions screening explicitly deferred to v2.
- **KYC-15-R2** FK behavior pinned: `provider_id` made NULLABLE on kyc_verifications + kyc_documents with ON DELETE SET NULL; kyc_documents → kyc_verifications ON DELETE RESTRICT; kyc_review_events.provider_id has NO FK (opaque UUID for audit continuity); kyc_review_events.actor_id ON DELETE SET NULL.
- **KYC-18-R2** Server-side validation at submission: RNOKPP 10-digit + checksum (weights [-1,5,7,9,4,6,10,5,7], mod 11 mod 10), ID-card 9-digit, passport-book `^[А-ЯІЇЄ]{2}\d{6}$`, foreign passport `^[A-Z0-9]{6,9}$`. 422 with field-level error codes.

**REFINEMENT-LEVEL resolutions:**
- **KYC-07-R2** Eviction UPDATE includes `AND status='in_review' AND review_started_at <= now()-4h` + version increment + `kyc_review_events` row.
- **KYC-02-R2** Resubmit atomically clears reviewed_by=NULL, review_started_at=NULL, increments submission_count + version. Partial queue index `WHERE status='submitted' AND reviewed_by IS NULL`.
- **KYC-08-R2** 24h cooling-off (429 `resubmit_too_soon`); lifetime cap 5 → 6th = 403 `submission_limit_reached`. Admin `/unblock` endpoint (SEC-006) bumps `submission_limit` by 5.
- **KYC-03-R2** `kek_version TEXT` column added; background re-encryption job batches 100 rows; idempotent.
- **KYC-04-R2** AWS Encryption SDK data-key caching (5min/1000B/100msg); KMS-degraded mode = read-only admin queue + feature flag `kyc_kms_degraded`.
- **KYC-07-R3** Per-admin claim cap = 10; 429 `claim_limit_exceeded`; metric + warning alert > 8 sustained 1h.
- **KYC-10-R2** Payments payout-time gate: SELECT joins provider_profiles + kyc_verifications, asserts payout_enabled + status=approved + (expires_at IS NULL OR > now()).
- **KYC-11-R2** UUID v4 for file_keys (random, no v1/v7). Bucket access logs = PII; 1-year retention; security/compliance role only.
- **KYC-12-R2** Provider AND admin doc access via app-tier proxy `GET .../documents/{id}/stream` — NO signed URLs returned to clients. Centralizes access logging + auth.
- **KYC-14-R2** `kyc_review_events PARTITION BY RANGE (created_at)` monthly, same maintenance pattern as `audit_events`.
- **KYC-16-R2** Mandatory blocking HEAD on confirm; quarantine prefix `kyc/quarantine/{upload_id}` with 2h auto-delete lifecycle; server-side copy to permanent prefix; cross-region replication DISABLED (data-residency); versioning ENABLED.
- **KYC-20-R2** Dedicated CMK (separate from media INF-003); same account/region; 30-day deletion protection; CloudWatch alarms on key state changes; BYOK requires HSM-backed offline key material; AWS-generated material uses annual rotation.

**Schema delta vs R1:**
- `kyc_documents` adds `kek_version TEXT NOT NULL DEFAULT 'v1'`
- `kyc_verifications` adds `submission_limit INT NOT NULL DEFAULT 5`
- `kyc_verifications.provider_id` and `kyc_documents.provider_id` made NULLABLE
- `kyc_review_events` becomes PARTITIONED BY RANGE(created_at)
- `cancelled` added to kyc_verifications.status CHECK
- 2 triggers added (provider_profiles payout/mfa + users mfa/payout)
- New endpoints: `GET /kyc/me/documents/{id}/stream`, `GET /admin/kyc/{provider_id}/documents/{id}/stream`, `POST /admin/kyc/{provider_id}/unblock`

## Round 2 — critic verdict: ACCEPT WITH REFINEMENTS
**Critic agent ID (R2):** abdf873b52467e36a

All 6 blockers ✅ RESOLVED. 14/14 refinement risks resolved (one as PARTIAL — see N1). 6 new risks introduced (all correction-class, NOT redesign):
- **RISK-N1** Reconciliation query covers only one drift direction (`approved AND payout_enabled=FALSE`); inverse `(rejected|expired) AND payout_enabled=TRUE` unmonitored. One-line fix.
- **RISK-N2** Trigger comment in `trg_users_mfa_payout_check` says "false→true" but logic guards "true→false". Comment must be corrected — implementer reading the comment could "fix" the guard backwards.
- **RISK-N3** RNOKPP checksum weight `-1` signed/unsigned ambiguity. Need worked numeric example pinning arithmetic convention (especially negative intermediate sum handling).
- **RISK-N4** App-tier streaming proxy memory/throughput note: response-body buffering disabled, separate deployment if scale demands.
- **RISK-N5** Admin `/unblock` lacks mandatory reason-code audit + absolute submission_limit ceiling. Without ceiling lifetime cap is unbounded via repeated unblocks.
- **RISK-N6** `kek_version` re-encryption job has no per-row atomicity guarantee with concurrent reads; encryption context must bind `kek_version` so SDK rejects mismatched key versions.

## Round 3 — architect final refinement (verbatim summary)
**Architect agent ID (R3):** a74a4a59637d08e0b

- **KYC-06-R3** Reconciliation query extended to UNION ALL both directions: (A) `kv.status='approved' AND payout_enabled=FALSE AND mfa_enabled=TRUE` (alert only), (B) `kv.status IN (rejected,expired,cancelled) AND payout_enabled=TRUE` (alert + immediate auto-correction `UPDATE provider_profiles SET payout_enabled=FALSE` + `kyc_review_events` row `event_type='reconciliation_auto_correction'`). Asymmetry rationale: financial exposure runs only in direction B.
- **KYC-05-R3** Trigger comment corrected to "preventing mfa_enabled true→false while payout_enabled=true". Function name changed to `fn_users_mfa_payout_check` for clarity. Trigger now `BEFORE UPDATE OF mfa_enabled` (column-specific). Behavior unchanged.
- **KYC-18-R3** RNOKPP arithmetic pinned: Euclidean modulo `((sum % 11) + 11) % 11`. Two worked examples provided (RNOKPP `3068217500` → check digit 0; `1234567899` showing weight `-1` step). Implementation note mandates Euclidean modulo for portability across truncated-division languages (C, Go, Java, JS).
- **KYC-12-R3** Streaming proxy operational requirements: chunked passthrough mandatory, 64KB buffer, response-body buffering disabled at LB, deployable as separate process when `kyc_document_stream_concurrent_count > 20` sustained 5min, 60s per-stream timeout, no proxy-layer caching.
- **KYC-08-R3** `/unblock` audit + ceiling: required `reason_code` enum (`legitimate_documentation_issue | system_error_during_submission | provider_appeal_resolved | other`) + optional `reason_note`. Absolute ceiling `submission_limit ≤ 20` (5 + 3×5 cycles). Beyond ceiling: 422 `unblock_ceiling_reached`, requires escalation to NEW `senior_admin` role (added to user_roles enum). Every unblock writes `kyc_review_events` row with full reason metadata.
- **KYC-04-R3** Encryption context binding: `{kek_version, document_id, provider_id}` in AWS Encryption SDK encryption context (AAD). Context mismatch at decrypt = SDK auth-tag failure = self-detecting race. Re-encryption UPDATE atomically writes all 3 PII columns + kek_version in single statement (PostgreSQL MVCC guarantees readers see consistent snapshot). Read path: SELECT all columns once, build context from row, decrypt; on auth fail single retry then 503.

## Synthesis — Final DECISION + RISK set

**Status:** ✅ ALL FLAGGED RISKS RESOLVED — proceeding to `/create-specification`

**Final DECISIONs (consolidated, R3-superseded where noted):**

*State machine + workflow:*
1. (KYC-01) State machine: `not_submitted → submitted → in_review → approved | rejected | expired | cancelled` + claim step prevents 2-admin race.
2. (KYC-02-R2) Required docs: 1 of {passport_ua | id_card | passport_foreign} + rnokpp + selfie. Optional fop_certificate. Resubmit atomically clears reviewer state + cooling-off guard.
3. (KYC-07-R2/R3) 4-hour stale-claim eviction with status guard + version increment + audit row. Per-admin claim cap 10 (429 + metric/alert).
4. (KYC-08-R3) Cooling-off 24h after rejection; lifetime cap 5 with absolute ceiling 20 (3 unblock cycles); admin `/unblock` requires reason_code + writes audit row; senior_admin escalation beyond 20.
5. (KYC-15-R2) Account-deleted-mid-review = soft-delete proceeds (KYC NOT a block); KYC transitions to `cancelled` terminal; 90-day restore returns to `not_submitted`.
6. (KYC-16-R2) No partial approval (binary decision); per-doc `verification_status` for visibility/guidance only.
7. (KYC-17) Single `kyc_verifications` row per provider; full history in `kyc_documents` via submission_index.

*Document validation (Ukrainian context):*
8. (KYC-18-R2/R3) RNOKPP 10-digit + Euclidean-modulo checksum (worked example pinned); ID-card `^\d{9}$`; passport-book `^[А-ЯІЇЄ]{2}\d{6}$`; foreign passport `^[A-Z0-9]{6,9}$`. Validated at submission with 422 + field-level codes.

*Encryption + KMS:*
9. (KYC-04-R2/R3) AES-256-GCM via AWS Encryption SDK with mandatory encryption context binding `{kek_version, document_id, provider_id}` (AAD); data-key caching 5min; KMS-degraded mode = read-only admin queue.
10. (KYC-03-R2 + R3) `kek_version` column tracks DEK version; background re-encryption job atomic per-row UPDATE; SDK auth-tag self-detects races; read-path retry contract.
11. (KYC-20-R2) Dedicated CMK separate from media; same account/region; 30-day deletion protection; CloudWatch alarms; restricted IAM (Decrypt + GenerateDataKey only).

*Storage + access:*
12. (KYC-09 / KYC-11-R2) UUID v4 file_keys; SSE-KMS bucket; no public access; cross-region replication DISABLED (data residency); versioning ENABLED. Access logs = PII (1y retention, security/compliance role only).
13. (KYC-12-R2/R3) App-tier streaming proxy for ALL document access (no signed URLs to clients). Chunked passthrough, 64KB buffer, deployable separately, 60s timeout.
14. (KYC-16-R2) Two-phase upload: pre-signed PUT → quarantine prefix → mandatory blocking HEAD on confirm → server-side copy to permanent → DELETE quarantine. 2h auto-delete on quarantine prefix.

*Cross-module + payout:*
15. (KYC-05-R2/R3) Dual triggers enforce `payout_enabled=true ⟺ kyc_status=approved AND mfa_enabled=true` at DB level (corrected trigger comment).
16. (KYC-06-R2/R3) Same-DB single-tx mutations (kyc_verifications + provider_profiles + outbox); enum mapping table; bidirectional reconciliation query (5min/P2) with auto-correction for direction B (revoked but payout still on).
17. (KYC-10-R2) Payments payout-time defense-in-depth read joins both tables checks expires_at + status + payout_enabled.

*Audit + retention:*
18. (KYC-11-R2 + KYC-14-R2) `kyc_review_events` append-only via DB GRANT (no UPDATE/DELETE); monthly partitioned (PARTITION BY RANGE(created_at)); IP/UA captured; never returned to providers.
19. (KYC-13-R2) Retention based on ЦК України ст. 257 (3y civil-law statute of limitations), AML claim explicitly dropped. Approved: raw docs purged 3y; metadata 7y. Rejected: raw docs 90d; metadata 3y. Sanctions screening explicitly deferred to v2.

*Authorization:*
20. (KYC-10) SEC-006 admin re-read on every admin mutation (claim, approve, reject, suspend, flag-rekyc, unblock).

**Residual notes (formally accepted):**
- Diia.ID / OCR / face-match deferred to v2.
- Sanctions screening (РНБО / EU / OFAC) deferred to v2 — retention rationale revised to civil-law (NOT AML).
- Four-eyes review for high-value KYC deferred (schema-compatible).
- `senior_admin` escalation endpoint for >20 submission_limit out of scope (separate process module).
- KMS degraded-mode runbook content out of spec (operational runbook).
- Notification delivery owned by Notifications module (consumes KYC outbox events).

## Наступний крок
✅ Викликати `/create-specification` skill для генерації фінального `spec/spec-architecture-kyc-provider-verification.md`. Після успіху:
1. Видалити цей WIP-файл.
2. Оновити memory: Module 4 DONE.

## Refinement rounds
**Status:** not started

## Synthesis (final DECISION + RISK set)
_to be filled after ACCEPT_

## Наступний крок

Викликати `architect` (subagent_type=architect) із prompt-ом нижче:

---
Propose the design for **Module 4 — KYC (Provider Verification)** of the Robotun freelance marketplace.

**Project context (read these specs):**
- `spec/spec-architecture-marketplace-social-platform.md` (umbrella)
- `spec/spec-architecture-users-authentication.md` (Module 1; SEC-006 admin re-read; provider_profiles.payout_enabled flag exists here)
- `spec/spec-architecture-deal-workflow.md` (Module 3; `deal.escrow_release_requested` consumer must check payout_enabled in Payments module)
- `CLAUDE.md` (conventions; KYC required before payout, NOT before Deal creation)

**Required scope — produce `[DECISION]` blocks for each:**
1. **KYC verification state machine** — formalize: not_submitted → submitted → in_review → approved | rejected | expired. Re-submission flow after rejection. Admin actor only for review. Define guards, side-effects, illegal transitions, idempotency.
2. **Document types** — Ukrainian-context documents: passport (паспорт громадянина України або закордонний), ID card, РНОКПП/ІПН (taxpayer number), optional ФОП certificate. Per-document verification status. Selfie / liveness photo. Document expiry tracking.
3. **Data model** — `kyc_verifications` (one current + history), `kyc_documents` (per-doc with file_key, type, expiry, verification_status), `kyc_review_events` (audit). PII fields encryption-at-rest considerations. Columns, indexes, FKs, constraints.
4. **REST API contract** — Provider: submit/resubmit, view own status, list submitted docs. Admin: list pending queue, view detail (with doc download URL), approve/reject (with reason codes). Webhooks/events for downstream (`kyc.approved`, `kyc.rejected`).
5. **Payout enablement contract** — how Payments module checks status. Atomic flip of `provider_profiles.payout_enabled = true` on approval. Reverse on suspension/expiry. Cross-module read pattern.
6. **Document storage & access** — object-store keys, signed-URL expiry, server-side encryption, access-log requirements. Who can read raw docs (admin only) vs metadata (provider).
7. **Authorization & audit** — admin role re-read (SEC-006), reason codes for rejection (machine-readable + free-text note), append-only audit log, IP/UA capture.
8. **Compliance & retention** — Ukrainian Personal Data Law (ЗУ «Про захист персональних даних»). Data retention windows for rejected vs approved. Right-to-erasure interaction (soft-delete cascade behaviour).
9. **Re-verification triggers** — document expiry sweep, periodic re-KYC (annual?), suspicious activity flag.
10. **Edge cases** — provider deletes account mid-review; document upload partial failure; admin reviews stale submission while user resubmits; multi-document partial approval.

**Tradeoffs to make explicit:** synchronous vs async OCR/face-match (defer to v2?); third-party KYC provider integration (Diia.ID? simple internal review?); how strict expiry rules (block all payouts if any doc expires?).

**Format:** `[DECISION]` blocks per topic. Production-ready, not exploratory.
---

After architect returns: paste full output verbatim into `critic` (subagent_type=critic).
