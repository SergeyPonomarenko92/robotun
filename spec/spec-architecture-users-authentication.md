---
title: Users & Authentication (SEC-001)
version: 1.0
date_created: 2026-04-18
last_updated: 2026-04-18
owner: Platform / Security Team
tags: [architecture, security, auth, rbac, users, marketplace]
---

# Introduction

This specification defines the user identity, authentication, authorization (RBAC), multi-factor authentication (MFA), session management, account lifecycle, and auditing subsystems for the freelance marketplace platform. It is the foundational module on which all other modules (Deals, Payments, Messaging, Reviews, Categories) depend.

## 1. Purpose & Scope

**In scope**

- Account registration, login, logout, token refresh
- Password storage and policy
- Email & phone verification
- Role model (`client`, `provider`, `admin`, `moderator`) with support for dual client+provider roles
- Role elevation workflow for provider onboarding
- Multi-factor authentication (TOTP)
- Session lifecycle and hygiene
- Soft-delete and GDPR-compliant erasure
- Rate limiting and anti-abuse controls for auth endpoints
- Auth-related audit logging

**Out of scope**

- OAuth / social login (planned v1.1)
- SAML / enterprise SSO (enterprise tier)
- Biometric authentication
- WebAuthn / Passkeys (planned v1.2)
- KYC identity verification workflow itself (covered in SEC-004)
- Payment / payout mechanics (covered in BIZ-PAY)

**Audience:** backend engineers, security reviewers, QA engineers, AI code-generation agents producing implementation code against this spec.

## 2. Definitions

| Term | Definition |
|------|------------|
| JWT | JSON Web Token — signed, self-describing access credential (RFC 7519). |
| RS256 | RSA-SHA256 JWT signing algorithm (asymmetric). |
| MFA | Multi-Factor Authentication. |
| TOTP | Time-based One-Time Password (RFC 6238). |
| RBAC | Role-Based Access Control. |
| KYC | Know Your Customer — identity verification for regulated payouts. |
| HIBP | "Have I Been Pwned" — public breached-password corpus (k-anonymity API). |
| Argon2id | Hybrid password-hashing function, PHC winner. |
| CITEXT | PostgreSQL case-insensitive text type. |
| Tombstone | Sentinel row retained after logical deletion to preserve uniqueness constraints. |
| Payout | Transfer of funds from platform escrow to a provider's external account. |
| Dual role | A single user account simultaneously holding both `client` and `provider` roles. |

## 3. Requirements, Constraints & Guidelines

### Functional Requirements

- **REQ-001**: The system SHALL support user registration via email + password, requiring email verification before any revenue-affecting action.
- **REQ-002**: The system SHALL allow a single user account to hold both `client` and `provider` roles simultaneously.
- **REQ-003**: The system SHALL expose REST/JSON endpoints over HTTPS for all authentication operations.
- **REQ-004**: Provider role elevation SHALL be a workflow, not a flag toggle: it creates a `provider_profiles` row with `kyc_status='none'` and does NOT enable payouts.
- **REQ-005**: `payout_enabled` SHALL become `true` only when BOTH `kyc_status='approved'` AND MFA is enrolled for that user.
- **REQ-006**: The system SHALL issue a short-lived access JWT (15 minutes) and a rotating opaque refresh token (30 days).
- **REQ-007**: Refresh tokens SHALL be stored at rest only as SHA-256 hashes, never in plaintext.
- **REQ-008**: The system SHALL support TOTP (RFC 6238) as a second factor, with 10 single-use recovery codes issued at enrollment.
- **REQ-009**: The system SHALL append an immutable audit event for every authentication-relevant action (login success/failure, logout, password change, MFA enroll/disable, role grant/revoke, account deletion, payout-related state change).
- **REQ-010**: The system SHALL support soft-deletion with 90-day restore window followed by permanent purge.

### Security Requirements

- **SEC-001**: Passwords SHALL be hashed with Argon2id using parameters m=64 MiB, t=3, p=1.
- **SEC-002**: Passwords SHALL have a minimum length of 10 characters and SHALL be checked against HIBP on signup and change; known-breached passwords SHALL be rejected.
- **SEC-003**: MFA SHALL be mandatory — unconditional and non-bypassable — for accounts holding `admin` or `moderator` roles.
- **SEC-004**: MFA SHALL be mandatory for provider accounts before `payout_enabled` can become `true`.
- **SEC-005**: Access JWTs SHALL be signed with RS256; the signing key SHALL be rotated at minimum every 90 days.
- **SEC-006**: For high-impact actions (payout initiation, admin mutations, role grants, MFA changes), the system SHALL re-read role and status state from the primary database and SHALL NOT rely solely on JWT claims.
- **SEC-007**: Login responses SHALL be uniform on success and failure in both shape and timing (≥ 300 ms constant-time floor) to prevent user enumeration.
- **SEC-008**: Login failures SHALL always return the generic error code `invalid_credentials` regardless of whether the email exists.
- **SEC-009**: Rate limits (see CON-003) SHALL be enforced at the API gateway.
- **SEC-010**: The system SHALL cap concurrent active sessions at 10 per user; the oldest session SHALL be revoked when the cap is exceeded.

### Constraints

- **CON-001**: The primary identifier for login is email (case-insensitive, stored as CITEXT). Phone is an optional secondary identifier.
- **CON-002**: Soft-deleted user records SHALL have their email rewritten to `deleted-{uuid}@tombstone.local` to preserve uniqueness; the original email SHALL be kept as a salted hash in `deleted_user_index` for the restore window only.
- **CON-003**: Rate limits:
  - `POST /auth/login`: 5 attempts/min/IP, 10 attempts/hour/email
  - `POST /auth/register`: 3 attempts/hour/IP
  - `POST /auth/password-reset`: 3 attempts/hour/email
  - CAPTCHA challenge activated after 3 consecutive failures
- **CON-004**: The `audit_events` table SHALL be append-only and partitioned by month.
- **CON-005**: A session-cleanup job SHALL run at least hourly to purge expired sessions and sessions whose `revoked_at` is older than 30 days.

### Guidelines

- **GUD-001**: Prefer stateless JWT validation on read-only low-risk paths for latency; accept the ≤15 min revocation lag as a deliberate trade-off.
- **GUD-002**: Keep the permission matrix versioned in source control; do not store permission strings per-user in the database.
- **GUD-003**: Emit audit events asynchronously via an outbox pattern; failure to write an audit event SHALL NOT silently succeed — mark the request as degraded.

### Patterns

- **PAT-001**: Refresh-token rotation — every successful refresh SHALL invalidate the prior refresh token and issue a new one atomically.
- **PAT-002**: Transactional outbox for audit events to ensure at-least-once delivery without blocking the request path.

## 4. Interfaces & Data Contracts

### 4.1 Data Model (PostgreSQL)

```sql
-- users
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT UNIQUE NOT NULL,
  phone            VARCHAR(20) UNIQUE,
  password_hash    TEXT NOT NULL,                 -- argon2id encoded
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','suspended','deleted')),
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret_enc   BYTEA,                         -- encrypted at rest (KMS)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

CREATE TABLE user_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  VARCHAR(64),
  avatar_url    TEXT,
  bio           TEXT,
  locale        VARCHAR(10),
  timezone      VARCHAR(64)
);

CREATE TABLE user_roles (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL
               CHECK (role IN ('client','provider','admin','moderator')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES users(id),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE provider_profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kyc_status       TEXT NOT NULL DEFAULT 'none'
                     CHECK (kyc_status IN ('none','pending','approved','rejected')),
  kyc_verified_at  TIMESTAMPTZ,
  payout_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  headline         VARCHAR(120),
  CHECK (NOT payout_enabled OR kyc_status = 'approved')
);

CREATE TABLE auth_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_h   TEXT NOT NULL,         -- SHA-256 hex
  device_info       JSONB,
  ip                INET,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX ON auth_sessions (user_id);
CREATE INDEX ON auth_sessions (refresh_token_h);
CREATE INDEX ON auth_sessions (expires_at);

CREATE TABLE mfa_recovery_codes (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,                -- SHA-256
  used_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE deleted_user_index (
  email_hash   TEXT PRIMARY KEY,           -- HMAC-SHA256 of original email
  user_id      UUID NOT NULL,
  deleted_at   TIMESTAMPTZ NOT NULL,
  purge_after  TIMESTAMPTZ NOT NULL         -- deleted_at + 90 days
);

CREATE TABLE audit_events (
  id              BIGSERIAL,
  actor_user_id   UUID,
  target_user_id  UUID,
  event_type      TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip              INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
-- monthly partitions created by maintenance job
```

### 4.2 REST API

All endpoints are prefixed with `/api/v1`. All request and response bodies are `application/json; charset=utf-8`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/auth/register` | public | Create account, send verification email |
| POST | `/auth/login` | public | Exchange credentials for tokens |
| POST | `/auth/refresh` | refresh cookie/body | Rotate refresh token, issue new access token |
| POST | `/auth/logout` | access | Revoke current session |
| POST | `/auth/logout-all` | access + recent-auth | Revoke all sessions |
| POST | `/auth/verify-email` | token | Confirm email ownership |
| POST | `/auth/password-reset` | public | Start password reset flow |
| POST | `/auth/password-reset/confirm` | reset token | Complete reset |
| GET | `/users/me` | access | Current user profile |
| PATCH | `/users/me` | access | Update profile fields |
| POST | `/users/me/roles/provider` | access | Add provider role (kyc_status='none') |
| POST | `/users/me/mfa/enroll` | access | Begin TOTP enrollment, returns provisioning URI |
| POST | `/users/me/mfa/verify` | access | Confirm TOTP code, activate MFA, issue recovery codes |
| DELETE | `/users/me/mfa` | access + MFA | Disable MFA (blocked if user is admin/moderator or has payout_enabled) |
| DELETE | `/users/me` | access + MFA | Soft-delete account |

#### 4.2.1 Register

```http
POST /api/v1/auth/register
Content-Type: application/json

{ "email": "jane@example.com", "password": "correct horse battery staple", "initial_role": "client" }
```

**201 Created**
```json
{ "user_id": "…", "email_verification_required": true }
```

#### 4.2.2 Login

```http
POST /api/v1/auth/login
{ "email": "jane@example.com", "password": "…", "totp": "123456" }
```

**200 OK**
```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "opaque-random-string"
}
```

**401 Unauthorized** (uniform body for bad creds, unknown email, wrong MFA)
```json
{ "error": "invalid_credentials" }
```

#### 4.2.3 Access JWT Claims

```json
{
  "iss": "https://auth.marketplace.example",
  "sub": "<user_uuid>",
  "iat": 1713456000,
  "exp": 1713456900,
  "jti": "<token_uuid>",
  "roles": ["client", "provider"],
  "mfa": true,
  "ver": 3
}
```

The `ver` claim increments on security-sensitive user changes (password reset, role revoke, MFA toggle) to force early client re-auth for sensitive flows.

## 5. Acceptance Criteria

- **AC-001**: Given a new user, When they `POST /auth/register` with a valid unused email and compliant password, Then a `users` row is created with `status='pending'`, `email_verified=false`, and an email verification message is dispatched.
- **AC-002**: Given an email already bound to an active account, When a second registration arrives for the same email, Then the response is `409 Conflict` with error `email_in_use` and NO signal of whether the original account is verified.
- **AC-003**: Given valid credentials without MFA enrolled, When `POST /auth/login` is called, Then the response includes a 15-minute access JWT and a 30-day refresh token, AND an `auth.login.success` audit event is written.
- **AC-004**: Given invalid credentials, When `POST /auth/login` is called, Then the response is `401` with body `{"error":"invalid_credentials"}` AND total server response time is ≥ 300 ms.
- **AC-005**: Given a user with `admin` role, When they attempt to log in without completing MFA, Then login SHALL fail with `mfa_required` and no access token SHALL be issued.
- **AC-006**: Given a provider with `kyc_status='approved'` but `mfa_enabled=false`, When the system evaluates `payout_enabled`, Then `payout_enabled` remains `false`.
- **AC-007**: Given a user who calls `POST /users/me/roles/provider`, Then a `provider_profiles` row is created with `kyc_status='none'`, `payout_enabled=false`, AND the `user_roles` table gains a `provider` entry.
- **AC-008**: Given a refresh token, When `POST /auth/refresh` succeeds, Then the prior refresh token's `auth_sessions` row is marked revoked in the same transaction that inserts the replacement.
- **AC-009**: Given an account being soft-deleted, When deletion commits, Then: `users.deleted_at` is set, `users.status='deleted'`, `users.email` is rewritten to `deleted-{uuid}@tombstone.local`, and a row is inserted into `deleted_user_index` with `purge_after = now() + 90 days`.
- **AC-010**: Given 11 simultaneous active sessions for one user, When a 12th login occurs, Then the oldest session is revoked and the session count remains ≤ 10.
- **AC-011**: Given 6 failed login attempts from one IP within one minute, When the 6th request arrives, Then the gateway returns `429 Too Many Requests`.
- **AC-012**: Given any auth-sensitive event (listed in REQ-009), When it completes, Then a corresponding row is present in `audit_events` within 5 seconds.

## 6. Test Automation Strategy

- **Test Levels**: unit (pure logic, claim building, password hashing wrapper), integration (endpoints against real Postgres + Redis), end-to-end (full register→verify→login→refresh→logout flow).
- **Frameworks**: language-agnostic; any mainstream test runner in the chosen stack. Property-based testing SHOULD be used for token-rotation and rate-limiter logic.
- **Test Data Management**: per-test schema via transactional rollback OR ephemeral Postgres container per suite; no shared mutable fixtures.
- **CI/CD Integration**: all levels run on every PR; security tests (password policy, rate limits, MFA gate) gate merges.
- **Coverage Requirements**: ≥ 90% line coverage for the `auth` package; 100% branch coverage for the permission-resolution function.
- **Performance Testing**: login endpoint SHALL sustain 500 RPS at p95 ≤ 400 ms including the constant-time floor; refresh endpoint SHALL sustain 2000 RPS at p95 ≤ 150 ms.
- **Security Testing**: automated checks for timing-based user enumeration, password-policy bypass, JWT `alg=none` acceptance, refresh-token replay.

## 7. Rationale & Context

- **REST over GraphQL** chosen because the auth surface is small, action-oriented, and benefits from HTTP caching, CDN edge rules, and standard WAF signatures. GraphQL's dynamic query shape complicates rate limiting and audit logging for auth flows.
- **Short JWT + rotating refresh** balances latency (no DB hit per request) against revocation needs (refresh is stateful). The 15-minute window bounds blast radius of leaked access tokens.
- **Dual-role users** reflect the empirical reality of marketplaces: freelancers frequently hire other freelancers. Forcing separate accounts would fragment identity, reputation, and dispute history.
- **Workflow-gated provider elevation** ensures that enabling payouts is never a single flag flip. Multiple independent gates (KYC approval + MFA enrollment) defend against both social-engineering and insider-risk scenarios.
- **Email tombstoning** resolves the tension between GDPR "right to erasure" and the uniqueness constraint required to prevent re-registration squatting during the 90-day restore window.
- **DB re-check on high-impact paths** accepts JWT's staleness for read paths (good UX, good scaling) while refusing it for anything that moves money or grants authority.
- **Constant-time login** closes the standard username-enumeration side channel, which is otherwise trivial to exploit in credential-stuffing campaigns.
- **Append-only audit log** is required for dispute resolution (who approved what, when) and is load-bearing for regulatory defensibility once the platform handles payouts.

## 8. Dependencies & External Integrations

### External Systems
- **EXT-001**: Email delivery provider — sends verification, password reset, MFA-disable notifications. Integration type: outbound SMTP or REST API with DKIM/SPF alignment.

### Third-Party Services
- **SVC-001**: HIBP Pwned Passwords API — k-anonymity SHA-1 prefix lookup for breached-password check on signup/change. Required availability: best-effort; on outage, accept password if policy otherwise satisfied.
- **SVC-002**: CAPTCHA provider (e.g., hCaptcha/Turnstile) — invoked after repeated auth failures. SLA: 99.9%.

### Infrastructure Dependencies
- **INF-001**: PostgreSQL 15+ — primary store for identity, sessions, audit events. Features required: CITEXT, JSONB, declarative partitioning, `gen_random_uuid()`.
- **INF-002**: Redis (or equivalent) — rate-limit counters, CAPTCHA trigger state, short-lived verification tokens.
- **INF-003**: KMS / HSM — encryption of TOTP secrets at rest and management of JWT signing keys.
- **INF-004**: API gateway with WAF — terminates TLS, enforces rate limits, invokes CAPTCHA challenge.

### Data Dependencies
- **DAT-EXT-001**: HIBP breached-password corpus — external, queried live via k-anonymity API.

### Technology Platform Dependencies
- **PLT-001**: Language runtime supporting constant-time comparison primitives and Argon2id library with FFI to a maintained reference implementation.
- **PLT-002**: TLS 1.2+ on all external-facing endpoints; HSTS enabled.

### Compliance Dependencies
- **COM-001**: GDPR — supports right to access, right to erasure (90-day tombstone then purge), lawful-basis tracking via audit log.
- **COM-002**: PSD2/SCA alignment — MFA mandatory on provider payout paths anticipates strong customer authentication requirements.
- **COM-003**: PCI DSS — out of scope for this module; card data never touches these services (handled by payments module via tokenized PSP).

## 9. Examples & Edge Cases

```text
# Edge case 1: Registration collides with a soft-deleted account within restore window
POST /auth/register { "email": "jane@example.com", ... }
→ 409 Conflict { "error": "email_in_use", "recovery_hint": "contact_support" }
# Rationale: the email is tombstoned but recoverable; silently reassigning would allow
# account-takeover-via-reregistration.

# Edge case 2: Admin loses MFA device
# - Admin CANNOT self-disable MFA (SEC-003).
# - Recovery code is first path; if exhausted, out-of-band admin-of-admins recovery required.
# - Event chain logged to audit_events with event_type='mfa.admin_recovery'.

# Edge case 3: Refresh token replay
# Attacker steals refresh token, user also uses it.
# First use rotates; second use arrives with a revoked token.
# → Session invalidated, ALL sessions for user_id revoked, security-incident audit event emitted,
#   user notified by email.

# Edge case 4: Dual-role user revoked from provider only
# user_roles DELETE WHERE role='provider'; client role retained.
# users.ver incremented → existing JWTs with provider claim invalidated on next sensitive call.
# provider_profiles retained (read-only) for historical dispute resolution.

# Edge case 5: Account deletion while active deals exist
# Soft-delete BLOCKED — return 409 with list of active deal IDs.
# User must cancel/complete deals or transfer ownership first. (Detail in BIZ-001 module.)

# Edge case 6: TOTP clock drift
# Accept window: current ± 1 step (±30s). Reject 2+ steps to limit replay.
```

## 10. Validation Criteria

A compliant implementation SHALL pass all of the following:

1. Every endpoint in §4.2 exists at the specified path and returns the documented status codes and body shapes.
2. All acceptance criteria AC-001 through AC-012 pass as automated integration tests.
3. A `SELECT` against the `users` table shows no plaintext passwords, no plaintext MFA secrets, and no plaintext refresh tokens.
4. `pg_partman` (or equivalent) produces monthly partitions for `audit_events` and the current/next month partitions always exist.
5. Load tests confirm the performance targets in §6.
6. Security scan confirms: no `alg=none` JWT acceptance; no user-enumeration timing signal > 20 ms variance; rate limits return `429` before hitting application code.
7. `CHECK (NOT payout_enabled OR kyc_status = 'approved')` constraint present and enforced on `provider_profiles`.
8. Admin and moderator accounts cannot authenticate without MFA.
9. Session cleanup job observed to remove expired rows within one hour of expiry.
10. An end-to-end deletion test confirms tombstone rewrite + `deleted_user_index` insert + 90-day `purge_after` value.

## 11. Related Specifications / Further Reading

- `spec-data-category-tree.md` (DAT-001) — category moderation uses `moderator` role defined here.
- `spec-process-deal-workflow.md` (BIZ-001) — deal actions authorized against roles defined here.
- `spec-process-kyc.md` (SEC-004) — drives `kyc_status` transitions on `provider_profiles`.
- `spec-architecture-payments-escrow.md` — consumes `payout_enabled` flag.
- RFC 6238 — TOTP
- RFC 7519 — JWT
- OWASP ASVS v4 — Authentication Verification Requirements (§V2)
- NIST SP 800-63B — Digital Identity Guidelines, Authentication
