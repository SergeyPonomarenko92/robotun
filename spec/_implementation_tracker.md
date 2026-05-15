---
title: Spec implementation tracker
date_created: 2026-05-15
owner: Ponomarenko
status: live
---

# Implementation Tracker

Single source of truth for "what's done vs what's left" across the spec corpus.
Sweep order: overview spec first (REQ-001..REQ-015), then each module spec in
dependency order (1→2→3...→14). Each line = one spec item with status:
- ✅ DONE — implemented + smoke-verified + (where applicable) deep-reviewer pass.
- 🟡 PARTIAL — partial coverage; describe what's missing.
- ❌ MISSING — no implementation.
- ⏭️ DESCOPED — explicitly out of MVP scope by spec or product decision.

After each closed item: commit hash in trailing `→ <hash>`.

---

## Overview (spec-architecture-marketplace-social-platform.md)

### §3.1 Functional
- REQ-001 dual roles (Provider+Consumer на one account) — ✅ user_roles M:N table.
- REQ-002 Provider profile page (avatar/name/bio/contacts/category/geo/portfolio/stories/avg_rating/review_count) — 🟡 partial (Module 7 surfaces avg_rating + review_count; provider_profiles details TBD).
- REQ-003 Portfolio Post 1-10 media + caption + tags — ❌ MISSING (Portfolio module not scaffolded).
- REQ-004 Story 24h auto-delete — ❌ MISSING.
- REQ-005 Listing offer/request — 🟡 (offers only; request type missing).
- REQ-006 Listing fields — ✅ Module 5.
- REQ-007 Review only after Deal — ✅ Module 7 (60d window post-completion).
- REQ-008 Review {rating 1-5, text, media, reply} — ✅.
- REQ-009 Search — ✅ Module 13.
- REQ-010 Feed mixed content — 🟡 Module 8 covers listings; Portfolio+Stories not in feed yet.
- REQ-011 DM 1-1 — ✅ Module 2.
- REQ-012 Follow — ❌ MISSING.
- REQ-013 Like + comment Portfolio Posts — ❌ MISSING (no Portfolio).
- REQ-014 Deal pending→active on Provider confirm — ✅ Module 3.
- REQ-015 User-proposed subcategory with admin approval — ✅ Module 10.

---

## Module 1 — Users & Authentication (spec-architecture-users-authentication.md)

### Functional (REQ-001..REQ-010)
- REQ-001 register via email+password, email verification required before revenue-affecting action — ✅ → 8168fb2 + this turn. register sets status='pending'; verifyEmail CASE-promotes pending→active; pending allowed in pwd reset / listings / deals / notification drain. Email_verified itself doesn't gate payout (REQ-005 contract is kyc+mfa only); spec REQ-001 satisfied transitively because KYC submission requires login-capable user.
- REQ-002 single user, both client+provider roles — ✅ user_roles + has_provider_role flag.
- REQ-003 REST/JSON over HTTPS — ✅ Fastify + TLS terminate at infra.
- REQ-004 provider role elevation = workflow not flag, creates provider_profiles row kyc_status='none' — ✅ this turn. POST /users/me/roles/provider + elevateToProvider() helper (SEC-006 status re-read, audit event role_granted_provider, 201 vs 200 idempotent). Migrations 0028+0029: provider_profiles table + payout_enabled CHECK constraint. kyc.service.syncUserKycStatus now updates both copies (users + provider_profiles) in the same tx.
- REQ-005 payout_enabled = (kyc_status='approved' AND mfa_enrolled) — ✅ d68d5a8 approve KYC sets payout=mfa_enrolled.
- REQ-006 15min access JWT + 30day refresh — ✅ c9bbe60.
- REQ-007 refresh stored as SHA-256 hash — ✅ c9bbe60.
- REQ-008 TOTP + 10 recovery codes — ✅ d7d0723 + 9676fd6.
- REQ-009 audit events for auth — ✅ ac95d12 + c1ea73a + bcaf173.
- REQ-010 soft-delete 90-day restore window — ✅ this turn. Migration 0030: users.deleted_at + deleted_user_index. deleteAccount stores salted-sha256(user_id|original_email) + purge_after=now()+90d. /admin/users/:id/restore reverses (status='pending', auto-trigger verify-email). deletedUsersPurge cron permanently deletes users row (cascade clears index). Critic RISK-1 (cron direction) + RISK-4 (TOCTOU on email) + RISK-8 (auto re-verify) all applied. **Deferred**: RISK-2 admin_actions.actor_admin_id RESTRICT blocks purge of admins who've made admin_actions — needs migration to ON DELETE SET NULL. RISK-3 per-row random salt vs predictable user_id salt — security hardening. RISK-7 email_now_taken vs email_in_use code naming.

### Security (SEC-001..SEC-010)
- SEC-001 Argon2id m=64MiB, t=3, p=1 — ✅ this turn. crypto.ARGON2_OPTS bumped from m=19MiB/t=2 to spec m=64MiB/t=3. DUMMY_HASH regenerated with new params so the email-not-found login path pays matching argon2.verify cost. Smoke: existing seed user (old-param hash) still logs in (argon2.verify reads params from the hash itself); new registrations emit `$argon2id$v=19$m=65536,t=3,p=1$...` hashes.
- SEC-002 10-char min + HIBP check — ✅ this turn. 12-char floor (≥ spec's 10); HIBP k-anonymity check on register/changePassword/resetPassword. Register wrapped in withFloor (timing oracle fix RISK-1); audit row on rejection (RISK-2); NaN count guard (RISK-5).
- SEC-003 MFA mandatory for admin/moderator — ✅ this turn. login + refresh both check (admin/mod OR has-role) && !mfa_enrolled → block. disableTotp 403 mfa_required_for_role for admin/mod (after pw+code verify so no oracle). Seed admin pre-enrolls with dev TOTP secret. **Deferred per critic**: RISK-1 spec amendment (AC-005 wording mfa_required vs mfa_enrollment_required), RISK-4 perf (cache is_privileged column), RISK-5 moderator route-gate consistency (spec ambiguous on which endpoints moderators access), RISK-6 require TOTP on resetPassword/changePassword for admins (next commit), RISK-7 seed rotation, RISK-8 distinct audit event mfa_enrollment_blocked.
- SEC-004 MFA mandatory for provider before payout — ✅ d68d5a8.
- SEC-005 RS256 + 90-day key rotation — 🟡 RS256 ✅; rotation procedural (not in code).
- SEC-006 high-impact actions re-read role+status from DB — ✅ verified. Payout init (FOR UPDATE on users), elevateToProvider (RISK-2 fix), disableTotp role re-check, admin route requireAdmin helpers — all query DB fresh, not JWT claims.
- SEC-007 login constant-time ≥300ms — ✅ withFloor.
- SEC-008 generic invalid_credentials — ✅.
- SEC-009 rate limits at gateway — ✅ a5b1a1d 240/min/IP global.
- SEC-010 10 concurrent sessions cap, oldest revoked — ✅ this turn. issueTokensFor (called from register/login/refresh) wraps in db.transaction with SELECT FOR UPDATE on active sessions, computes overflow, revokes oldest BY created_at ASC, INSERT new — single tx. session_cap_revoked audit event with session_ids in metadata. Critic RISK-3 known: rotation makes created_at imperfect proxy for session age; documented for v2 session-origin lineage.

### Constraints (CON-001..CON-005)
- CON-001 email CITEXT primary, phone secondary — 🟡 email **CITEXT done** (migration 0031); phone column STILL NOT modeled (deferred — REQ-002 scope, separate feature).
- CON-002 soft-deleted email→tombstone + deleted_user_index — ✅ this turn. Email→`deleted-{uuid}@tombstone.local` per spec wording; deleted_user_index keeps salted hash.
- CON-003 rate limits (exact thresholds) — 🟡 240/min/IP global; per-route fine-grained per spec TBD.
- CON-004 audit_events append-only + monthly partitioned — 🟡 auth_audit_events append-only, NOT partitioned.
- CON-005 hourly session cleanup — ✅ 7c3d884 sessions_purge cron 60s tick.

### Acceptance (AC-001..AC-012)
- AC-001 register → status='pending' + email_verified=false + verification dispatched — ✅ this turn.
- AC-002 second register for same email → 409 + no signal — ✅ (code is email_taken not email_in_use — rename TBD).
- AC-003 login → 15min JWT + 30day refresh + audit — ✅.
- AC-004 invalid creds → 401 + ≥300ms — ✅.
- AC-005 admin without MFA → mfa_required, no token — ✅ this turn (code emits `mfa_enrollment_required` for un-enrolled admin; spec AC-005 wording amendment deferred).
- AC-006 kyc_approved + mfa=false → payout_enabled=false — ✅.
- AC-007 POST /users/me/roles/provider creates provider_profiles + user_roles entry — ✅ this turn.
- AC-008 refresh rotates atomically — ✅.
- AC-009 soft-delete → deleted_at + status + email rename + deleted_user_index — ✅ this turn. Smoke confirms all 4 outputs of the AC.
- AC-010 11th session → oldest revoked, count≤10 — ✅ this turn. Smoke 12 sequential logins: counts grow to 10 then stay at exactly 10 from 10th login onward. 3 session_cap_revoked audit rows confirm eviction.
- AC-011 6 failed logins / 1 min / IP → 429 — 🟡 global 240/min/IP + 5/15min/email; not the spec metric.
- AC-012 audit event within 5s — ✅ (synchronous insert in same request).

---

## Module 2 — Category Tree (spec-data-category-tree.md)

### Functional (REQ-001..REQ-011)
- REQ-001 adjacency list + level∈{1,2,3} CHECK — ✅ schema.ts categories.level + CHECK.
- REQ-002 authenticated user proposes non-root under active parent — ✅ submitProposal.
- REQ-003 root creation admin-only — ✅ adminCreate gated by requireAdmin.
- REQ-004 server-side slug from name — ✅ slug.ts pipeline.
- REQ-005 admin slug_override on approve — ✅ approveProposal accepts override.
- REQ-006 global slug uniqueness across active + pending — ✅ pg_advisory_xact_lock(1) on slug critical section + unique partial indexes (PAT-003).
- REQ-007 approved appears in GET within 60s — 🟡 GET /categories serves from DB (no Redis cache yet); the 60s SLO is trivially met but the SPEC §4.6 cache layer is descoped.
- REQ-008 audit_events for category writes — ⏭️ DESCOPED MVP (Module 12 admin_actions covers admin-side). Spec calls for category_audit_events table; not built.
- REQ-009 outbox event for category writes — ✅ all mutations insert outboxEvents.
- REQ-010 archived stays referenceable, blocks new — ✅ P0004 trigger blocks listings INSERT to archived category.
- REQ-011 soft-deleted user → auto-reject proposals — ✅ this turn. deleteAccount emits user.soft_deleted to outbox; categoriesUserSoftDeleteConsumer cron job (60s tick) consumes via dedicated cursor 'categories:user_soft_deleted', flips pending proposals to auto_rejected with rejection_code='proposer_deleted', emits category.auto_rejected outbox per proposal. Critic RISK-1 (event emission) + RISK-4 (tx FOR UPDATE) applied. RISK-2 (audit_events row) deferred — REQ-008 descope.

### Security
- SEC-001 high-impact actions re-read role from DB — ✅ admin routes call requireAdmin which queries DB.
- SEC-002 Redis Lua rate limits — ⏭️ DESCOPED MVP; @fastify/rate-limit at gateway is the fallback per memory.
- SEC-003 reserved-slug list — ✅ slug.ts has RESERVED_SLUGS.

### Constraints (CON-001..CON-007)
- CON-001 tree depth cap 3 — ✅ level CHECK + parent-level check in submitProposal/adminCreate.
- CON-002 slug regex normalized — ✅ slug.ts.
- CON-003 no hard-delete, archive-only — ✅ trg_categories_no_delete (P0005).
- CON-004 no reparenting — ✅ trg_categories_no_reparent (BEFORE UPDATE).
- CON-005 rate limits (5 proposals/24h/user, 30 admin-rejects/h, 20 archives/h, 60 admin-creates/h) — 🟡 only @fastify/rate-limit global; per-route Lua deferred.
- CON-006 LOCAL statement_timeout=5s in archive-cascade — ✅ archiveCategory wraps SET LOCAL.
- CON-007 failed proposals count rate-limit (anti-enumeration) — 🟡 same as CON-005 — deferred Lua dependency.

### Acceptance (AC-001..AC-014)
- AC-001 valid proposal → pending row + computed slug returned — ✅.
- AC-002 duplicate slug → 409 duplicate_category — ✅.
- AC-003 parent level 3 → 422 max_depth_exceeded — ✅.
- AC-004 approve without override → categories row + auto-reject race losers — ✅.
- AC-005 approve with override → uses override + auto-reject — ✅.
- AC-006 moderator approve → 403 — ✅ admin role required, moderator excluded.
- AC-007 moderator 30 rejects/h → 429 — 🟡 not enforced (Lua dep).
- AC-008 user 5 proposals/24h cap → 429 — 🟡 not enforced (Lua dep).
- AC-009 archive cascade=false with children → 409 has_active_children — ✅.
- AC-010 archive cascade=true ≤20 descendants → all flip → ✅; >20 → spec says async worker. Today: returns 422.
- AC-011 listing INSERT to archived category → 422 (CROSS-001 trigger) — ✅ trg_listing_active_category P0004.
- AC-012 user soft-deleted → consume → auto-reject proposals — ✅ this turn. 60s cron tick consumes user.soft_deleted, flips proposals + emits category.auto_rejected. Live smoke confirmed.
- AC-013 raw DELETE on categories → P0005 SQLSTATE — ✅.
- AC-014 approval observable in /categories within 60s — ✅ trivial without cache.

**Module 2 closed**: 17 items. **Open**: REQ-011 / AC-012 (user soft-delete → proposal auto-reject — needs outbox consumer), AC-007/008/CON-005-007 (Lua rate limits — DESCOPED block), REQ-008 (audit table — DESCOPED), REQ-007 cache layer (DESCOPED).

---

## Module 3-14 (стиснуто; деталі по REQ-list — у трекер коли черга)
- Module 2 Categories (spec-data-category-tree.md): MVP DONE (2c10370) — see expanded sweep above.
- Module 3 Deals (spec-architecture-deal-workflow.md): MVP DONE + deep-review fixes (efafd78 + cc81f69 + а74160b). **Module 3 AC-010** (cancel-request 48h expiry sweep) ✅ this turn — new `dealCancelRequestExpiry` cron job with critic refinements (RISK-1 narrowed CASE SET, RISK-3 ORDER BY GREATEST timestamp for FIFO-by-age). Deferred: RISK-4 notification template for `deal.cancel_request_expired`, RISK-5 metadata.requested_by_role + §4.7 projection whitelist. Module 3 REMAINING gaps: REQ-003/004 escrow async flow (Module 11 dependency), REQ-014/015 release sweep + auto-complete refinement (Module 11 dep), AC-005 /internal/escrow-held endpoint (Module 11 dep).
- Module 4 KYC (spec-architecture-kyc-provider-verification.md): MVP DONE (fbd3be2) + sweep this turn:
  - **REQ-006 suspend** ✅ a99a2c9 — POST /admin/kyc/:provider_id/suspend (approved → rejected, payout off, outbox kyc.suspended). Reason enum: fraud_detected|compliance_violation|provider_request|platform_policy_breach|other. Single source of truth via SUSPEND_REASON_CODES export.
  - **REQ-009 pre-expiry warn** ✅ 2e4dba4 — kycPreExpiryWarn cron flags approved KYC ≤30d from expires_at, sets rekyc_required_at + rekyc_required_reason='document_expiry', emits outbox kyc.rekyc_required. Critic RISK-1/2 inline: approve()+flagRekyc() now clear rekyc_required_at on transition so the 30d warn re-fires across approval cycles. Side-effect: latent postgres-js Date-binding bug in approve() fixed (kyc_approved_at COALESCE param cast to text/timestamptz). Deferred: critic RISK-3 annual re-KYC sweep §4.12 row 4.
  - **REQ-011 flag-rekyc** ✅ 00effa2 — POST /admin/kyc/:provider_id/flag-rekyc with critic RISK-2 (status guard approved|submitted|in_review only) + RISK-4 (requireAdmin JOIN users.status='active' for SEC-006). Reason ≥5 chars.
  - **REQ-012 unblock** ✅ 3eccb4c — POST /admin/kyc/:provider_id/unblock (+5 bump, ceiling 20). Critic RISK-1 (status whitelist rejected|expired only), RISK-2 (UNBLOCK_REASON_CODES single source), RISK-3 (reason_note required when reason='other').
  - **REQ-014 ip+ua audit** ✅ ab02b19 — migration 0032 adds kyc_review_events.ip + user_agent. logEvent + service fns + routes all thread req.ip/headers["user-agent"] into AuditCtx. SEC-006: never returned to provider endpoints.
  - **REQ-015 soft-delete cancel** ✅ d0560aa — kycUserSoftDeleteConsumer cron consumes user.soft_deleted, flips kyc → cancelled w/ reason='account_deleted', emits outbox kyc.cancelled. restoreAccount uncancels back to not_submitted within the 90d window.
  - **SEC-010 claim cap** ✅ f122388 — per-admin in_review ≤10; advisory lock pg_advisory_xact_lock(hashtext(admin_id)::bigint) inside claim() tx + count(*) check, 11th → 429 claim_limit_exceeded.
  - **REQ-013 streaming proxy** ✅ bd970db — GET /kyc/me/documents/:id/stream + GET /admin/kyc/:provider_id/documents/:id/stream. s3.streamObject + resolveStreamableDocument (single-tx authz + admin-only audit). No signed URLs to clients. Routes set Content-Disposition: attachment, X-Content-Type-Options: nosniff, Cache-Control: private no-store, 60s socket timeout, Readable.from(body, {objectMode:false}) for byte-level back-pressure. Critic RISK-b/c applied, RISK-d (provider unaudited + commit-before-stream false-positive) documented inline.
  - **REQ-009 annual re-KYC sweep** ✅ d835249 — kycAnnualRekyc cron defense-in-depth for non-expiring doc types (decided_at ≥365d old + rekyc_required_reason IS NULL). Idempotent on rekyc_required_reason. Closes SEC-010 critic RISK-3 follow-up.
  - **AC-017 / AC-018 ✅** — chunked stream + admin document_accessed audit row with ip/ua (REQ-013 commit).
  - **Remaining Module 4 work**: SEC-002/003 PII encryption (AWS KMS dependency — out of MVP), CON-003/004 sanctions screening (DESCOPED MVP), CON-009 file size/MIME ✅ verified (media.service.ts:94 enforces kyc_document MIME set, clamav.ts notes 20MB cap).
- Module 5 Listings: MVP DONE + KYC gate (1d93fbb + 63f493f).
- Module 6 Media: MVP DONE + ClamAV + variants (fbd3be2 + 37e649e + 7ee3a1a + 376927e + 9ab35cf).
- Module 7 Reviews: MVP DONE + deep-review (4884c3d + cc81f69 + cffd1dd).
- Module 8 Feed: MVP DONE (72a7563).
- Module 9 Notifications: MVP DONE + email + push (73f8431 + 20e3374 + d38cf5d).
- Module 11 Payments: MVP DONE (b13f0b5).
- Module 12 Admin: MVP DONE (b7c5b52).
- Module 13 Search: MVP DONE (spec lists separate REQ-list; not yet swept here).
- Module 14 Disputes: MVP DONE (5783279 + 47875fb).

Кожен модуль потребує окремого REQ-by-REQ sweep як Module 1 вище. Заплановано після завершення Module 1.

---

## Active task

**Module 1 closed (16 items)**: REQ-001, REQ-004, REQ-010, AC-001, AC-005, AC-007, AC-009, AC-010, AC-011, AC-012, SEC-001, SEC-002, SEC-003, SEC-006, SEC-010, CON-002. **Module 1 partially closed**: CON-001 (CITEXT done, phone column TBD). **Module 1 remaining MISSING/PARTIAL**: REQ-002 (Provider profile page details — needs Module 4+7+8 cross-section), REQ-004 audit-event for role grant (RISK-1 from earlier critic — minor), SEC-005 RS256 90-day key rotation (procedural), CON-004 audit_events monthly partitioning (bigger), AC-002 code rename email_taken→email_in_use (minor).

**Phase next**: pivoting to Module 2 (Category Tree) or Module 3 (Deal Workflow) REQ sweep. Both modules already have MVP code shipped — sweep checks each REQ vs implementation.

**Module 4 spec sweep COMPLETE for MVP** (HEAD d835249): REQ-006/009/009-annual/011/012/013/014/015 + SEC-010 + CON-009 verified. Open out-of-MVP: SEC-002/003 PII encryption (AWS KMS), CON-003/004 sanctions (legal/AML — descoped).
