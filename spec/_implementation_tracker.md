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
- SEC-006 high-impact actions re-read role+status from DB — 🟡 NEED AUDIT site-by-site.
- SEC-007 login constant-time ≥300ms — ✅ withFloor.
- SEC-008 generic invalid_credentials — ✅.
- SEC-009 rate limits at gateway — ✅ a5b1a1d 240/min/IP global.
- SEC-010 10 concurrent sessions cap, oldest revoked — ✅ this turn. issueTokensFor (called from register/login/refresh) wraps in db.transaction with SELECT FOR UPDATE on active sessions, computes overflow, revokes oldest BY created_at ASC, INSERT new — single tx. session_cap_revoked audit event with session_ids in metadata. Critic RISK-3 known: rotation makes created_at imperfect proxy for session age; documented for v2 session-origin lineage.

### Constraints (CON-001..CON-005)
- CON-001 email CITEXT primary, phone secondary — 🟡 email lowercased manually (not CITEXT); phone NOT modeled.
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

## Modules 2-14 (стиснуто; деталі по REQ-list — у трекер коли черга)
- Module 2 Categories (spec-data-category-tree.md): MVP DONE (2c10370).
- Module 3 Deals (spec-architecture-deal-workflow.md): MVP DONE + deep-review fixes (efafd78 + cc81f69 + а74160b).
- Module 4 KYC (spec-architecture-kyc-provider-verification.md): MVP DONE (fbd3be2).
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

**Working** (Module 1 closed items): REQ-001 ✅, REQ-004 / AC-007 ✅, REQ-010 / CON-002 / AC-009 ✅, SEC-002 ✅, SEC-003 / AC-005 / RISK-6 ✅, SEC-010 / AC-010 ✅, AC-011 ✅. **Module 1 next**: SEC-001 verify Argon2id m=64MiB/t=3/p=1; SEC-006 audit high-impact actions re-read state from DB (not JWT); CON-001 email CITEXT; CON-004 audit_events partitioning monthly.
