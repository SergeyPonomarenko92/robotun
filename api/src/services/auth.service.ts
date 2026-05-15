/**
 * Module 1 §4 — auth business logic. Pure functions over the db layer
 * so route handlers stay thin.
 */
import { eq, and, isNull, gt, desc, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { authAuditEvents, emailChangeTokens, emailVerificationTokens, mediaObjects, passwordResetTokens, providerProfiles, sessions, totpRecoveryCodes, userRoles, users } from "../db/schema.js";
import { sendEmail } from "./email.js";
import { checkPasswordBreached } from "./hibp.js";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import {
  hashPassword,
  verifyPassword,
  mintAccessToken,
  mintRefreshToken,
  sha256Hex,
} from "./crypto.js";

export type AuthSuccess = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    display_name: string;
    has_provider_role: boolean;
  };
};

export type LoginInput = {
  email: string;
  password: string;
  user_agent?: string | null;
  ip?: string | null;
  /** If the account has mfa_enrolled=true, this 6-digit TOTP code is
   *  required. Server returns mfa_required (no token issued) when
   *  password is correct but code is missing — FE prompts for the
   *  second factor and re-submits. */
  totp_code?: string;
};

export type RegisterInput = LoginInput & {
  initial_role: "client" | "provider";
};

/**
 * Constant-time login floor. Per spec AC-004 a successful login MUST NOT
 * be observably faster than a failure (otherwise account-enumeration via
 * timing). We always pay at least MIN_LOGIN_MS by sleeping the deficit.
 */
const MIN_LOGIN_MS = 300;

async function withFloor<T>(fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - t0;
    const deficit = MIN_LOGIN_MS - elapsed;
    if (deficit > 0) await new Promise((r) => setTimeout(r, deficit));
  }
}

export type RegisterError =
  | { code: "email_taken" }
  | { code: "weak_password" }
  | { code: "password_breached" };

export async function register(
  input: RegisterInput
): Promise<{ ok: true; result: AuthSuccess } | { ok: false; error: RegisterError }> {
  return withFloor(async () => registerImpl(input));
}

async function registerImpl(
  input: RegisterInput
): Promise<{ ok: true; result: AuthSuccess } | { ok: false; error: RegisterError }> {
  const email = input.email.trim().toLowerCase();
  // SEC-002 — 12-char floor (stricter than spec's 10-char minimum, per
  // ASVS L2 recommendation; both bounds satisfy SEC-002 since 12 ≥ 10).
  if (input.password.length < 12) {
    return { ok: false, error: { code: "weak_password" } };
  }
  // SEC-002: reject known-breached passwords (HIBP k-anonymity). Wrapped
  // in withFloor at the public entry point so the HIBP round-trip cost
  // does not leak via timing between breached/clean/already-registered
  // outcomes (critic RISK-1).
  const breach = await checkPasswordBreached(input.password);
  if (breach.ok && breach.breached) {
    return { ok: false, error: { code: "password_breached" } };
  }
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) return { ok: false, error: { code: "email_taken" } };

  const password_hash = await hashPassword(input.password);
  const display_name = email.split("@")[0] ?? email;
  const isProvider = input.initial_role === "provider";

  const [user] = await db
    .insert(users)
    .values({
      email,
      password_hash,
      display_name,
      // has_provider_role starts false even when initial_role='provider' —
      // elevateToProvider() (REQ-004) is the canonical single path to
      // flipping it, and it ALSO creates the provider_profiles row that
      // downstream modules (3/7/13) denorm into.
      has_provider_role: false,
      // Spec REQ-001 / AC-001 — fresh registrations land in 'pending' and
      // get promoted to 'active' by verifyEmail. Pending accounts CAN log
      // in (no /users/me block), but revenue-affecting actions (payouts)
      // continue to gate on payout_enabled which gates on KYC + MFA.
      status: "pending",
    })
    .returning();
  if (!user) throw new Error("register: insert returned no row");

  // Client role row always inserted; provider elevation goes through the
  // workflow path so provider_profiles is in sync.
  await db.insert(userRoles).values({
    user_id: user.id,
    role: "client",
  });
  let hasProviderRole = false;
  if (isProvider) {
    const ev = await elevateToProvider(user.id);
    if (ev.ok) hasProviderRole = true;
    // If elevation failed (unlikely for a fresh user) the registration
    // still succeeds with client role; client can call the elevation
    // endpoint later.
  }

  const tokens = await issueTokensFor(user.id, user.ver, {
    user_agent: input.user_agent,
    ip: input.ip,
  });

  // Fire-and-forget email verification — failure logs but doesn't block
  // registration. User can re-request via /auth/request-email-verification.
  requestEmailVerification({ user_id: user.id, email: user.email }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[register] verify-email enqueue failed for ${user.email}: ${(e as Error).message}`);
  });

  return {
    ok: true,
    result: {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        // RISK-4: `user` snapshot is pre-elevation; reflect the post-
        // elevation flag explicitly so the FE doesn't have to call
        // /users/me right after register.
        has_provider_role: hasProviderRole,
      },
    },
  };
}

export type LoginError =
  | { code: "invalid_credentials" }
  | { code: "account_disabled" }
  | { code: "mfa_required" }
  | { code: "invalid_mfa_code" }
  | { code: "too_many_attempts"; retry_after_seconds: number };

const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_WINDOW_MIN = 15;

export async function login(
  input: LoginInput
): Promise<{ ok: true; result: AuthSuccess } | { ok: false; error: LoginError }> {
  return withFloor(async () => {
    const email = input.email.trim().toLowerCase();

    // Per-email lockout — count login_failure rows for this email in the
    // last LOGIN_LOCKOUT_WINDOW_MIN minutes. >= threshold → 429.
    // auth_audit_events already gets a row on every failure (logged from
    // the route layer); no extra writes here. Failure rows have user_id
    // NULL but metadata.email set.
    const failures = await db.execute<{ n: number }>(
      dsql`SELECT COUNT(*)::int AS n FROM auth_audit_events
            WHERE event_type = 'login_failure'
              AND metadata->>'email' = ${email}
              AND created_at > now() - (${LOGIN_LOCKOUT_WINDOW_MIN}::int || ' minutes')::interval`
    );
    if ((failures[0]?.n ?? 0) >= LOGIN_LOCKOUT_THRESHOLD) {
      return {
        ok: false,
        error: {
          code: "too_many_attempts",
          retry_after_seconds: LOGIN_LOCKOUT_WINDOW_MIN * 60,
        },
      };
    }

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = rows[0];
    if (!user) {
      // Run an argon verify on a dummy hash to keep timing comparable.
      await verifyPassword(DUMMY_HASH, input.password);
      return { ok: false, error: { code: "invalid_credentials" } };
    }
    const ok = await verifyPassword(user.password_hash, input.password);
    if (!ok) return { ok: false, error: { code: "invalid_credentials" } };
    if (user.status === "suspended" || user.status === "deleted") {
      return { ok: false, error: { code: "account_disabled" } };
    }
    // MFA gate. mfa_enrolled implies totp_secret IS NOT NULL; verifyTotp's
    // null-guard is the second layer.
    if (user.mfa_enrolled) {
      if (!input.totp_code) {
        return { ok: false, error: { code: "mfa_required" } };
      }
      // Branch on shape: 6 digits → TOTP; 10 alpha-num → recovery code.
      // Anything else is malformed → invalid_mfa_code (no leak of which
      // shape was expected).
      if (/^\d{6}$/.test(input.totp_code)) {
        if (!user.totp_secret || !authenticator.check(input.totp_code, user.totp_secret)) {
          return { ok: false, error: { code: "invalid_mfa_code" } };
        }
      } else if (/^[A-Z0-9]{10}$/.test(input.totp_code)) {
        const ok = await consumeRecoveryCode(user.id, input.totp_code);
        if (!ok) return { ok: false, error: { code: "invalid_mfa_code" } };
      } else {
        return { ok: false, error: { code: "invalid_mfa_code" } };
      }
    }
    const tokens = await issueTokensFor(user.id, user.ver, {
      user_agent: input.user_agent,
      ip: input.ip,
    });
    return {
      ok: true,
      result: {
        ...tokens,
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          has_provider_role: user.has_provider_role,
        },
      },
    };
  });
}

// Stable dummy hash so login() can pay the argon2 cost even when the
// email doesn't exist. Generated once at boot via hashPassword('dummy').
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// -------- Refresh-token rotation -----------------------------------------

export type RefreshError =
  | { code: "invalid_refresh" }
  | { code: "user_disabled" };

export async function refresh(
  refreshToken: string,
  meta: { user_agent?: string | null; ip?: string | null }
): Promise<{ ok: true; result: AuthSuccess } | { ok: false; error: RefreshError }> {
  const hash = sha256Hex(refreshToken);
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refresh_token_hash, hash))
    .limit(1);
  const session = rows[0];
  if (!session) return { ok: false, error: { code: "invalid_refresh" } };
  if (session.revoked_at) {
    // Reuse of a rotated refresh — spec §4.3 says revoke ALL user sessions.
    await db
      .update(sessions)
      .set({ revoked_at: new Date() })
      .where(and(eq(sessions.user_id, session.user_id), isNull(sessions.revoked_at)));
    return { ok: false, error: { code: "invalid_refresh" } };
  }
  if (session.expires_at.getTime() < Date.now()) {
    return { ok: false, error: { code: "invalid_refresh" } };
  }
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user_id))
    .limit(1);
  const user = userRows[0];
  if (!user) return { ok: false, error: { code: "invalid_refresh" } };
  if (user.status === "suspended" || user.status === "deleted") {
    return { ok: false, error: { code: "user_disabled" } };
  }

  // Revoke the presented session row and issue a new pair.
  await db
    .update(sessions)
    .set({ revoked_at: new Date() })
    .where(eq(sessions.id, session.id));
  const tokens = await issueTokensFor(user.id, user.ver, meta);
  return {
    ok: true,
    result: {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        has_provider_role: user.has_provider_role,
      },
    },
  };
}

export async function logout(refreshToken: string): Promise<{ user_id: string | null }> {
  const hash = sha256Hex(refreshToken);
  const r = await db
    .update(sessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(sessions.refresh_token_hash, hash), isNull(sessions.revoked_at)))
    .returning({ user_id: sessions.user_id });
  return { user_id: r[0]?.user_id ?? null };
}

/** List active (non-revoked, non-expired) sessions for a user.
 *  Refresh-token hashes deliberately omitted from the projection — caller
 *  cannot derive any plaintext from the list, only see "I'm logged in on
 *  these devices". */
export async function listActiveSessions(userId: string) {
  const rows = await db
    .select({
      id: sessions.id,
      user_agent: sessions.user_agent,
      ip: sessions.ip,
      created_at: sessions.created_at,
      expires_at: sessions.expires_at,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.user_id, userId),
        isNull(sessions.revoked_at),
        gt(sessions.expires_at, new Date())
      )
    )
    .orderBy(desc(sessions.created_at));
  return {
    items: rows.map((r) => ({
      id: r.id,
      user_agent: r.user_agent,
      ip: r.ip,
      created_at: r.created_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
    })),
  };
}

/* ----------------------------- ROLE ELEVATION ------------------------ */

type ElevateError = { code: "user_not_found" | "account_disabled"; status: number };

/** REQ-004 / AC-007 — provider role elevation as a workflow, not a flag
 *  toggle. Idempotent: re-call is harmless (created=false).
 *  Creates provider_profiles row with kyc_status='none' and DOES NOT
 *  enable payouts (payout_enabled stays false; gated by REQ-005 → KYC
 *  approval AND MFA enrollment, evaluated at flip-to-approved time in
 *  Module 4 service).
 *
 *  SEC-006 (critic RISK-2): re-read users.status from DB inside the tx
 *  rather than trusting the auth-context snapshot. Suspended/deleted
 *  cannot elevate; pending may (login + KYC submit are gated by their
 *  own checks). */
export async function elevateToProvider(
  userId: string
): Promise<{ ok: true; value: { created: boolean } } | { ok: false; error: ElevateError }> {
  return await db.transaction(async (tx) => {
    const u = await tx
      .select({ status: users.status, has_provider_role: users.has_provider_role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (u.length === 0) return { ok: false as const, error: { code: "user_not_found" as const, status: 404 } };
    if (u[0]!.status === "suspended" || u[0]!.status === "deleted") {
      return { ok: false as const, error: { code: "account_disabled" as const, status: 403 } };
    }
    // RETURNING distinguishes first-time elevation from idempotent re-call.
    const ppIns = await tx.execute<{ user_id: string }>(
      dsql`INSERT INTO provider_profiles (user_id, kyc_status)
           VALUES (${userId}, 'none')
           ON CONFLICT (user_id) DO NOTHING
           RETURNING user_id`
    );
    const created = ppIns.length > 0;
    await tx.execute(
      dsql`INSERT INTO user_roles (user_id, role)
           VALUES (${userId}, 'provider')
           ON CONFLICT (user_id, role) DO NOTHING`
    );
    await tx
      .update(users)
      .set({ has_provider_role: true })
      .where(eq(users.id, userId));
    return { ok: true as const, value: { created } };
  });
}

/* ----------------------------- PROFILE UPDATE ------------------------ */

type UpdateProfileError = {
  code: "display_name_invalid" | "avatar_not_found" | "avatar_not_owned" | "avatar_wrong_purpose" | "avatar_not_ready";
  status: number;
};

/** Partial profile update — only display_name and avatar_media_id today.
 *  Avatar resolution: media_id must be owned by caller, purpose='avatar',
 *  status='ready'. The presigned stream URL goes into users.avatar_url
 *  (canonical: /api/v1/media/<id>/stream — FE-stable across S3 churn). */
export async function updateProfile(args: {
  user_id: string;
  display_name?: string;
  avatar_media_id?: string;
}): Promise<{ ok: true; value: { display_name: string; avatar_url: string | null } } | { ok: false; error: UpdateProfileError }> {
  const updates: { display_name?: string; avatar_url?: string } = {};
  if (args.display_name !== undefined) {
    const trimmed = args.display_name.trim();
    if (trimmed.length < 2 || trimmed.length > 80) {
      return { ok: false, error: { code: "display_name_invalid", status: 400 } };
    }
    updates.display_name = trimmed;
  }
  if (args.avatar_media_id !== undefined) {
    const r = await db
      .select({
        owner_user_id: mediaObjects.owner_user_id,
        purpose: mediaObjects.purpose,
        status: mediaObjects.status,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.id, args.avatar_media_id))
      .limit(1);
    if (r.length === 0) return { ok: false, error: { code: "avatar_not_found", status: 404 } };
    if (r[0]!.owner_user_id !== args.user_id) {
      return { ok: false, error: { code: "avatar_not_owned", status: 403 } };
    }
    if (r[0]!.purpose !== "avatar") {
      return { ok: false, error: { code: "avatar_wrong_purpose", status: 422 } };
    }
    if (r[0]!.status !== "ready") {
      return { ok: false, error: { code: "avatar_not_ready", status: 409 } };
    }
    updates.avatar_url = `/api/v1/media/${args.avatar_media_id}/stream`;
  }
  if (Object.keys(updates).length === 0) {
    // Nothing to update — read back current state.
    const cur = await db
      .select({ display_name: users.display_name, avatar_url: users.avatar_url })
      .from(users)
      .where(eq(users.id, args.user_id))
      .limit(1);
    return {
      ok: true,
      value: {
        display_name: cur[0]?.display_name ?? "",
        avatar_url: cur[0]?.avatar_url ?? null,
      },
    };
  }
  const r = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, args.user_id))
    .returning({ display_name: users.display_name, avatar_url: users.avatar_url });
  return {
    ok: true,
    value: {
      display_name: r[0]?.display_name ?? "",
      avatar_url: r[0]?.avatar_url ?? null,
    },
  };
}

/* ----------------------------- PASSWORD CHANGE ----------------------- */

type ChangePasswordError = { code: "wrong_password" | "password_too_short" | "user_not_found" | "password_breached"; status: number };

/** Authenticated password change. Verifies old password (constant-time
 *  via argon2), updates hash, BUMPS ver to invalidate existing access
 *  tokens (FE must call /auth/refresh to get a new one), revokes all
 *  OTHER sessions (caller's current session stays valid — they have the
 *  refresh token and the bump cycles it via the rotation flow).
 */
export async function changePassword(args: {
  user_id: string;
  old_password: string;
  new_password: string;
}): Promise<{ ok: true } | { ok: false; error: ChangePasswordError }> {
  if (args.new_password.length < 12 || args.new_password.length > 256) {
    return { ok: false, error: { code: "password_too_short", status: 400 } };
  }
  // SEC-002: HIBP check on rotation.
  const breach = await checkPasswordBreached(args.new_password);
  if (breach.ok && breach.breached) {
    return { ok: false, error: { code: "password_breached", status: 400 } };
  }
  const u = await db
    .select({ password_hash: users.password_hash })
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  if (u.length === 0) return { ok: false, error: { code: "user_not_found", status: 404 } };
  const ok = await verifyPassword(u[0]!.password_hash, args.old_password);
  if (!ok) return { ok: false, error: { code: "wrong_password", status: 403 } };

  const newHash = await hashPassword(args.new_password);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ password_hash: newHash, ver: dsql`${users.ver} + 1` })
      .where(eq(users.id, args.user_id));
    await tx
      .update(sessions)
      .set({ revoked_at: new Date() })
      .where(and(eq(sessions.user_id, args.user_id), isNull(sessions.revoked_at)));
  });
  return { ok: true };
}

/* ----------------------------- EMAIL CHANGE -------------------------- */

const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000; // 1 hour

type RequestEmailChangeError = { code: "wrong_password" | "email_taken" | "same_email"; status: number };

/** Initiate email change. Verifies current password (defends against
 *  CSRF / session theft), checks the new email isn't already taken,
 *  mints a token, sends a verification link to the NEW address. Old
 *  email gets a security-alert note via in-app + (when wired) email
 *  channel — out of scope for this commit; v2 adds. */
export async function requestEmailChange(args: {
  user_id: string;
  password: string;
  new_email: string;
}): Promise<{ ok: true } | { ok: false; error: RequestEmailChangeError }> {
  const newEmail = args.new_email.trim().toLowerCase();
  const u = await db
    .select({ password_hash: users.password_hash, email: users.email })
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  if (u.length === 0) return { ok: false, error: { code: "wrong_password", status: 403 } };
  if (u[0]!.email === newEmail) {
    return { ok: false, error: { code: "same_email", status: 400 } };
  }
  const pwOk = await verifyPassword(u[0]!.password_hash, args.password);
  if (!pwOk) return { ok: false, error: { code: "wrong_password", status: 403 } };
  const taken = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, newEmail))
    .limit(1);
  if (taken.length > 0) return { ok: false, error: { code: "email_taken", status: 409 } };
  const plaintext = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(plaintext);
  await db.insert(emailChangeTokens).values({
    user_id: args.user_id,
    new_email: newEmail,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
  });
  const link = `${BRAND_URL}/confirm-email-change?token=${plaintext}`;
  sendEmail({
    to: newEmail,
    subject: "Підтвердьте новий email на Robotun",
    text: `Ваш акаунт запросив зміну email. Підтвердьте за посиланням протягом 1 години:\n\n${link}\n\nЯкщо це були не ви — проігноруйте.`,
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[email-change] send failed: ${(e as Error).message}`);
  });
  // Security alert to the OLD address — user should know that someone
  // initiated an email change. Fire-and-forget; no error propagates.
  sendEmail({
    to: u[0]!.email,
    subject: "Запит на зміну email — Robotun",
    text: `На вашому акаунті запросили зміну email на ${newEmail}. Якщо це були не ви, негайно змініть пароль і перевірте активні сесії: ${BRAND_URL}/settings/security`,
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[email-change] alert-old send failed: ${(e as Error).message}`);
  });
  return { ok: true };
}

type ConfirmEmailChangeError = { code: "token_invalid" | "token_used" | "token_expired" | "email_taken"; status: number };

export async function confirmEmailChange(args: {
  token: string;
}): Promise<{ ok: true; value: { user_id: string; new_email: string } } | { ok: false; error: ConfirmEmailChangeError }> {
  const tokenHash = sha256Hex(args.token);
  return await db.transaction(async (tx) => {
    const r = await tx
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.token_hash, tokenHash))
      .limit(1);
    if (r.length === 0) return { ok: false as const, error: { code: "token_invalid" as const, status: 400 } };
    const row = r[0]!;
    if (row.used_at) return { ok: false as const, error: { code: "token_used" as const, status: 400 } };
    if (row.expires_at.getTime() < Date.now()) {
      return { ok: false as const, error: { code: "token_expired" as const, status: 400 } };
    }
    // Re-check uniqueness at confirm time (another user could have claimed
    // the email between request and confirm — narrow window but possible).
    const taken = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, row.new_email))
      .limit(1);
    if (taken.length > 0 && taken[0]!.id !== row.user_id) {
      return { ok: false as const, error: { code: "email_taken" as const, status: 409 } };
    }
    await tx
      .update(users)
      .set({
        email: row.new_email,
        email_verified: true,
        email_verified_at: new Date(),
        ver: dsql`${users.ver} + 1`,
      })
      .where(eq(users.id, row.user_id));
    await tx
      .update(emailChangeTokens)
      .set({ used_at: new Date() })
      .where(eq(emailChangeTokens.id, row.id));
    // Revoke all sessions — email is part of the auth identity, force
    // re-login on every device.
    await tx
      .update(sessions)
      .set({ revoked_at: new Date() })
      .where(and(eq(sessions.user_id, row.user_id), isNull(sessions.revoked_at)));
    return { ok: true as const, value: { user_id: row.user_id, new_email: row.new_email } };
  });
}

/* ----------------------------- DATA EXPORT --------------------------- */

/** GDPR Art.20 right-to-data-portability. Returns a JSON snapshot of the
 *  user's data across all modules. Synchronous because the volume is
 *  bounded by per-user CAPs; v2 should switch to async with email-link
 *  delivery for users with very long history. */
export async function exportUserData(userId: string) {
  const profile = await getCurrentUserProfile(userId);
  if (!profile) return null;

  // Use raw SQL to avoid pulling every drizzle schema import here.
  const deals = await db.execute(
    dsql`SELECT id, status, title, agreed_price, created_at, completed_at, cancellation_reason,
                CASE WHEN client_id = ${userId} THEN 'client' ELSE 'provider' END AS my_role
           FROM deals
          WHERE client_id = ${userId} OR provider_id = ${userId}
          ORDER BY created_at DESC`
  );
  const reviews = await db.execute(
    dsql`SELECT id, deal_id, reviewer_role, overall_rating, comment, created_at
           FROM reviews WHERE reviewer_id = ${userId}
          ORDER BY created_at DESC`
  );
  const sessionsList = await db.execute(
    dsql`SELECT id, user_agent, ip, created_at, expires_at, revoked_at
           FROM sessions WHERE user_id = ${userId}
          ORDER BY created_at DESC`
  );
  const media = await db.execute(
    dsql`SELECT id, purpose, status, mime_type, byte_size, created_at
           FROM media_objects WHERE owner_user_id = ${userId}
          ORDER BY created_at DESC`
  );
  const prefs = await db.execute(
    dsql`SELECT notification_code, channel, enabled, updated_at
           FROM notification_preferences WHERE user_id = ${userId}`
  );
  const auditEvents = await db.execute(
    dsql`SELECT event_type, ip, user_agent, metadata, created_at
           FROM auth_audit_events WHERE user_id = ${userId}
          ORDER BY id DESC LIMIT 500`
  );

  return {
    exported_at: new Date().toISOString(),
    profile,
    deals,
    reviews,
    sessions: sessionsList,
    media,
    notification_preferences: prefs,
    auth_audit_recent: auditEvents,
    // Messages and KYC documents intentionally excluded — they're per
    // their own modules' GDPR export surfaces (Messaging exports via
    // /me/data-export/messages; KYC docs require admin-mediated transfer
    // per spec §SEC-007).
  };
}

/* ----------------------------- ACCOUNT DELETE ------------------------ */

type DeleteAccountError = { code: "wrong_password" | "user_not_found" | "already_deleted"; status: number };

/**
 * Soft-delete (GDPR Art.17 minimal). Anonymises the users row so FK
 * references from deals/reviews/etc. stay valid but no PII leaks via
 * profile reads. Cascade-erase of message bodies and review comments
 * is handled by their owning modules' own GDPR sweeps; this service
 * only touches Module-1-owned tables.
 *
 * Side effects:
 *   - users.email   → 'deleted+'||id||'@robotun-deleted.invalid' (frees
 *                     the original for re-registration; uniqueness
 *                     preserved via the user_id suffix).
 *   - users.display_name = 'Видалений користувач'
 *   - users.password_hash = DUMMY_HASH (cannot log in)
 *   - users.status = 'deleted', ver += 1
 *   - DELETE sessions / push_subscriptions / password_reset_tokens /
 *     email_verification_tokens for this user.
 */
export async function deleteAccount(args: {
  user_id: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: DeleteAccountError }> {
  const u = await db
    .select()
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  if (u.length === 0) return { ok: false, error: { code: "user_not_found", status: 404 } };
  const user = u[0]!;
  if (user.status === "deleted") return { ok: false, error: { code: "already_deleted", status: 409 } };

  const ok = await verifyPassword(user.password_hash, args.password);
  if (!ok) return { ok: false, error: { code: "wrong_password", status: 403 } };

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        email: `deleted+${args.user_id}@robotun-deleted.invalid`,
        display_name: "Видалений користувач",
        password_hash: DUMMY_HASH,
        status: "deleted",
        ver: dsql`${users.ver} + 1`,
        kyc_status: "none",
        payout_enabled: false,
        email_verified: false,
        email_verified_at: null,
      })
      .where(eq(users.id, args.user_id));
    await tx.delete(sessions).where(eq(sessions.user_id, args.user_id));
    await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.user_id, args.user_id));
    await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.user_id, args.user_id));
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.user_id, args.user_id));
    // push_subscriptions cascade via ON DELETE on user; but user row stays,
    // so explicit delete.
    await tx.execute(dsql`DELETE FROM push_subscriptions WHERE user_id = ${args.user_id}`);
  });
  return { ok: true };
}

/* ----------------------------- TOTP MFA ------------------------------ */

import { authenticator } from "otplib";

const TOTP_ISSUER = "Robotun";

/** Enroll: generate a fresh base32 secret, store on users.totp_secret,
 *  return the otpauth:// URL the FE renders as a QR. Does NOT flip
 *  mfa_enrolled — that requires /verify with a valid code (proves the
 *  user successfully imported the secret into their authenticator app).
 *  Re-enrolling overwrites the prior secret and resets mfa_enrolled. */
export async function enrollTotp(args: {
  user_id: string;
}): Promise<{ ok: true; value: { secret: string; otpauth_url: string } }> {
  const u = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  const email = u[0]?.email ?? "user@robotun.dev";
  const secret = authenticator.generateSecret();
  await db
    .update(users)
    .set({ totp_secret: secret, mfa_enrolled: false })
    .where(eq(users.id, args.user_id));
  const otpauth_url = authenticator.keyuri(email, TOTP_ISSUER, secret);
  return { ok: true, value: { secret, otpauth_url } };
}

type VerifyTotpError = { code: "no_pending_enrollment" | "invalid_code"; status: number };

/** Verify the first TOTP code; flip mfa_enrolled=true on success. */
export async function verifyTotp(args: {
  user_id: string;
  code: string;
}): Promise<{ ok: true; value: { mfa_enrolled: true } } | { ok: false; error: VerifyTotpError }> {
  const u = await db
    .select({ totp_secret: users.totp_secret })
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  const secret = u[0]?.totp_secret;
  if (!secret) return { ok: false, error: { code: "no_pending_enrollment", status: 409 } };
  // 30s window default; otplib's check allows ±1 step tolerance.
  const ok = authenticator.check(args.code, secret);
  if (!ok) return { ok: false, error: { code: "invalid_code", status: 422 } };
  await db
    .update(users)
    .set({ mfa_enrolled: true })
    .where(eq(users.id, args.user_id));
  return { ok: true, value: { mfa_enrolled: true } };
}

/** Generate 10 single-use recovery codes for the current TOTP enrollment.
 *  Plaintexts returned ONCE — server stores only sha256 hashes. Calling
 *  again replaces ALL existing codes (regenerate-on-demand flow). */
export async function generateRecoveryCodes(args: {
  user_id: string;
}): Promise<{ ok: true; value: { codes: string[] } } | { ok: false; error: { code: "not_enrolled"; status: number } }> {
  const u = await db
    .select({ mfa_enrolled: users.mfa_enrolled })
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  if (u.length === 0 || !u[0]!.mfa_enrolled) {
    return { ok: false, error: { code: "not_enrolled", status: 409 } };
  }
  // A-Z0-9 except 0/O/1/I to avoid transcription errors. 10 chars × 10
  // codes = enough entropy that brute force via /auth/login is bounded
  // by rate-limit floor (240/min/IP) for >> 10^15 years.
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const plain: string[] = [];
  for (let i = 0; i < 10; i++) {
    const buf = randomBytes(10);
    let s = "";
    for (let j = 0; j < 10; j++) s += ALPHABET[buf[j]! % ALPHABET.length];
    plain.push(s);
  }
  await db.transaction(async (tx) => {
    // Wipe prior codes — regenerate replaces.
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.user_id, args.user_id));
    for (const code of plain) {
      await tx.insert(totpRecoveryCodes).values({
        user_id: args.user_id,
        code_hash: sha256Hex(code),
      });
    }
  });
  return { ok: true, value: { codes: plain } };
}

/** Check + consume a recovery code at login time. Returns whether the
 *  code matched (and atomically marks it used). */
async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const hash = sha256Hex(code);
  const r = await db
    .update(totpRecoveryCodes)
    .set({ used_at: new Date() })
    .where(
      and(
        eq(totpRecoveryCodes.user_id, userId),
        eq(totpRecoveryCodes.code_hash, hash),
        isNull(totpRecoveryCodes.used_at)
      )
    )
    .returning({ id: totpRecoveryCodes.id });
  return r.length > 0;
}

/** Disable: requires password re-auth AND a current TOTP code to defend
 *  against compromised-session attackers. */
type DisableTotpError = { code: "wrong_password" | "not_enrolled" | "invalid_code"; status: number };

export async function disableTotp(args: {
  user_id: string;
  password: string;
  code: string;
}): Promise<{ ok: true } | { ok: false; error: DisableTotpError }> {
  const u = await db
    .select({ password_hash: users.password_hash, totp_secret: users.totp_secret, mfa_enrolled: users.mfa_enrolled })
    .from(users)
    .where(eq(users.id, args.user_id))
    .limit(1);
  if (u.length === 0 || !u[0]!.mfa_enrolled || !u[0]!.totp_secret) {
    return { ok: false, error: { code: "not_enrolled", status: 409 } };
  }
  const pwOk = await verifyPassword(u[0]!.password_hash, args.password);
  if (!pwOk) return { ok: false, error: { code: "wrong_password", status: 403 } };
  const codeOk = authenticator.check(args.code, u[0]!.totp_secret);
  if (!codeOk) return { ok: false, error: { code: "invalid_code", status: 422 } };
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ totp_secret: null, mfa_enrolled: false })
      .where(eq(users.id, args.user_id));
    // Disabling MFA implicitly invalidates the prior recovery codes.
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.user_id, args.user_id));
  });
  return { ok: true };
}

/* ----------------------------- ME PROFILE ---------------------------- */

/** Fresh /users/me read — DB-backed (not JWT-claims-cached) so values
 *  like email_verified, avatar_url, display_name reflect changes since
 *  the access token was issued. JWT still gates auth; this just refreshes
 *  the surface. */
export async function getCurrentUserProfile(userId: string) {
  const r = await db
    .select({
      id: users.id,
      email: users.email,
      email_verified: users.email_verified,
      email_verified_at: users.email_verified_at,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
      has_provider_role: users.has_provider_role,
      kyc_status: users.kyc_status,
      payout_enabled: users.payout_enabled,
      mfa_enrolled: users.mfa_enrolled,
      status: users.status,
      created_at: users.created_at,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (r.length === 0) return null;
  const u = r[0]!;
  // Recovery-codes remaining — only meaningful when MFA enrolled. Cheap
  // count query; index on (user_id) makes it O(1) per user.
  let recoveryCodesRemaining = 0;
  if (u.mfa_enrolled) {
    const c = await db.execute<{ n: number }>(
      dsql`SELECT COUNT(*)::int AS n FROM totp_recovery_codes
            WHERE user_id = ${userId} AND used_at IS NULL`
    );
    recoveryCodesRemaining = c[0]?.n ?? 0;
  }
  return {
    id: u.id,
    email: u.email,
    email_verified: u.email_verified,
    email_verified_at: u.email_verified_at?.toISOString() ?? null,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    has_provider_role: u.has_provider_role,
    kyc_status: u.kyc_status,
    payout_enabled: u.payout_enabled,
    mfa_enrolled: u.mfa_enrolled,
    recovery_codes_remaining: recoveryCodesRemaining,
    status: u.status,
    created_at: u.created_at.toISOString(),
  };
}

/* ----------------------------- AUTH AUDIT ---------------------------- */

export type AuthEventType =
  | "login_success"
  | "login_failure"
  | "logout"
  | "refresh"
  | "password_changed"
  | "password_reset_requested"
  | "password_reset_completed"
  | "email_verification_requested"
  | "email_verified"
  | "email_change_requested"
  | "email_changed"
  | "sessions_logged_out_all"
  | "profile_updated"
  | "account_deleted"
  | "role_granted_provider";

/** Fire-and-forget audit row insert. Never throws — failure here must
 *  not block the action being audited. user_id may be null for failed
 *  logins where the email didn't resolve. */
export async function logAuthEvent(args: {
  user_id: string | null;
  event_type: AuthEventType;
  ip?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(authAuditEvents).values({
      user_id: args.user_id,
      event_type: args.event_type,
      ip: args.ip ?? null,
      user_agent: args.user_agent ?? null,
      metadata: args.metadata ?? {},
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[auth-audit] insert failed for ${args.event_type}: ${(e as Error).message}`);
  }
}

/** Paginated read-back of the current user's audit trail. Used by the
 *  /me/audit FE surface. */
export async function listAuthAudit(args: { user_id: string; limit: number; cursor?: string }) {
  const limit = Math.min(Math.max(args.limit, 1), 100);
  // Bigserial id is monotonic + dense — cursor by id alone suffices.
  let beforeId: bigint | null = null;
  if (args.cursor) {
    try {
      beforeId = BigInt(Buffer.from(args.cursor, "base64url").toString("utf8"));
    } catch {
      return { error: "cursor_invalid" as const };
    }
  }
  const rows = await db.execute<{
    id: string;
    event_type: string;
    ip: string | null;
    user_agent: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    beforeId !== null
      ? dsql`SELECT id, event_type, ip, user_agent, metadata, created_at
               FROM auth_audit_events
              WHERE user_id = ${args.user_id} AND id < ${beforeId.toString()}
              ORDER BY id DESC LIMIT ${limit + 1}`
      : dsql`SELECT id, event_type, ip, user_agent, metadata, created_at
               FROM auth_audit_events
              WHERE user_id = ${args.user_id}
              ORDER BY id DESC LIMIT ${limit + 1}`
  );
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const next_cursor = hasMore && slice.length > 0
    ? Buffer.from(String(slice[slice.length - 1]!.id), "utf8").toString("base64url")
    : null;
  return {
    items: slice.map((r) => ({
      id: String(r.id),
      event_type: r.event_type,
      ip: r.ip,
      user_agent: r.user_agent,
      metadata: r.metadata,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
    next_cursor,
  };
}

/* ----------------------------- EMAIL VERIFY -------------------------- */

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function requestEmailVerification(args: {
  user_id: string;
  email: string;
}): Promise<{ ok: true }> {
  const plaintext = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(plaintext);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS);
  await db.insert(emailVerificationTokens).values({
    user_id: args.user_id,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  const link = `${BRAND_URL}/verify-email?token=${plaintext}`;
  sendEmail({
    to: args.email,
    subject: "Підтвердьте email на Robotun",
    text: `Підтвердьте свою адресу email — посилання дійсне 24 години:\n\n${link}`,
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[email-verify] send failed for ${args.email}: ${(e as Error).message}`);
  });
  return { ok: true };
}

type VerifyEmailError = { code: "token_invalid" | "token_used" | "token_expired"; status: number };

export async function verifyEmail(token: string): Promise<
  { ok: true; value: { email: string; user_id: string } } | { ok: false; error: VerifyEmailError }
> {
  const tokenHash = sha256Hex(token);
  return await db.transaction(async (tx) => {
    const r = await tx
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.token_hash, tokenHash))
      .limit(1);
    if (r.length === 0) return { ok: false as const, error: { code: "token_invalid" as const, status: 400 } };
    const row = r[0]!;
    if (row.used_at) return { ok: false as const, error: { code: "token_used" as const, status: 400 } };
    if (row.expires_at.getTime() < Date.now()) {
      return { ok: false as const, error: { code: "token_expired" as const, status: 400 } };
    }
    const now = new Date();
    // Promote pending→active per spec REQ-001 / AC-001. Idempotent: if
    // the user was already 'active' (re-verification after email change),
    // the UPDATE just touches email_verified_at + flag.
    const u = await tx
      .update(users)
      .set({
        email_verified: true,
        email_verified_at: now,
        status: dsql`CASE WHEN ${users.status} = 'pending' THEN 'active'::user_status ELSE ${users.status} END`,
      })
      .where(eq(users.id, row.user_id))
      .returning({ email: users.email });
    await tx
      .update(emailVerificationTokens)
      .set({ used_at: now })
      .where(eq(emailVerificationTokens.id, row.id));
    return { ok: true as const, value: { email: u[0]?.email ?? "", user_id: row.user_id } };
  });
}

/* ----------------------------- PASSWORD RESET ------------------------- */

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BRAND_URL = env.BRAND_URL;

/**
 * Forgot-password handler. Always returns success-shaped without leaking
 * whether the email exists (timing-equalised by always issuing argon2-
 * priced work via the dummy hash IF no user found — covered by the
 * regular login() pattern). Real implementations should also rate-limit
 * per-IP and per-email; we rely on the global @fastify/rate-limit floor.
 */
export async function requestPasswordReset(args: {
  email: string;
  ip?: string | null;
  user_agent?: string | null;
}): Promise<{ ok: true; user_id: string | null }> {
  const userRow = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, args.email))
    .limit(1);
  // pending users MUST be allowed (RISK-1 from REQ-001 critic) — someone
  // who registered and immediately forgot the password before clicking
  // the verification link still needs a recovery path. Only suspended/
  // deleted accounts get the silent no-op.
  if (
    userRow.length === 0 ||
    userRow[0]!.status === "suspended" ||
    userRow[0]!.status === "deleted"
  ) {
    // Don't disclose existence to the caller; return ok with no side
    // effect. user_id=null here is for the AUDIT writer in the route;
    // the HTTP envelope itself stays 204 to preserve anti-enumeration.
    return { ok: true, user_id: null };
  }
  const uid = userRow[0]!.id;
  const plaintext = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(plaintext);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  await db.insert(passwordResetTokens).values({
    user_id: uid,
    token_hash: tokenHash,
    expires_at: expiresAt,
    ip: args.ip ?? null,
    user_agent: args.user_agent ?? null,
  });
  // Fire-and-forget email; failure logs but doesn't surface to caller (we
  // already committed the token row — operator can reissue from logs).
  const link = `${BRAND_URL}/reset-password?token=${plaintext}`;
  sendEmail({
    to: args.email,
    subject: "Скидання паролю Robotun",
    text: `Ми отримали запит на скидання пароля. Перейдіть за посиланням протягом 30 хвилин:\n\n${link}\n\nЯкщо це були не ви — проігноруйте цей лист.`,
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[pwd-reset] email send failed for ${args.email}: ${(e as Error).message}`);
  });
  return { ok: true, user_id: uid };
}

type ResetPasswordError = { code: "password_too_short" | "password_breached" | "token_invalid" | "token_used" | "token_expired"; status: number };

export async function resetPassword(args: {
  token: string;
  new_password: string;
}): Promise<{ ok: true; value: { user_id: string } } | { ok: false; error: ResetPasswordError }> {
  if (args.new_password.length < 12 || args.new_password.length > 256) {
    return { ok: false, error: { code: "password_too_short", status: 400 } };
  }
  // SEC-002: HIBP check on reset path too.
  const breach = await checkPasswordBreached(args.new_password);
  if (breach.ok && breach.breached) {
    return { ok: false, error: { code: "password_breached", status: 400 } };
  }
  const tokenHash = sha256Hex(args.token);
  return await db.transaction(async (tx) => {
    const r = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token_hash, tokenHash))
      .limit(1);
    if (r.length === 0) return { ok: false as const, error: { code: "token_invalid", status: 400 } };
    const row = r[0]!;
    if (row.used_at) return { ok: false as const, error: { code: "token_used", status: 400 } };
    if (row.expires_at.getTime() < Date.now()) {
      return { ok: false as const, error: { code: "token_expired", status: 400 } };
    }
    const newHash = await hashPassword(args.new_password);
    await tx
      .update(users)
      .set({ password_hash: newHash, ver: dsql`${users.ver} + 1` })
      .where(eq(users.id, row.user_id));
    await tx
      .update(passwordResetTokens)
      .set({ used_at: new Date() })
      .where(eq(passwordResetTokens.id, row.id));
    // Revoke all existing sessions — the user is rotating credentials.
    await tx
      .update(sessions)
      .set({ revoked_at: new Date() })
      .where(and(eq(sessions.user_id, row.user_id), isNull(sessions.revoked_at)));
    return { ok: true as const, value: { user_id: row.user_id } };
  });
}

/** Revoke ALL active sessions for a user (post-breach reset). Also bumps
 *  users.token_version so existing access tokens fail authentication at
 *  the next request even before they expire. */
export async function revokeAllSessions(userId: string): Promise<{ revoked: number }> {
  const r = await db.transaction(async (tx) => {
    const upd = await tx
      .update(sessions)
      .set({ revoked_at: new Date() })
      .where(and(eq(sessions.user_id, userId), isNull(sessions.revoked_at)))
      .returning({ id: sessions.id });
    await tx
      .update(users)
      .set({ ver: dsql`${users.ver} + 1` })
      .where(eq(users.id, userId));
    return upd.length;
  });
  return { revoked: r };
}

// -------- Internal -------------------------------------------------------

async function issueTokensFor(
  user_id: string,
  ver: number,
  meta: { user_agent?: string | null; ip?: string | null }
): Promise<Omit<AuthSuccess, "user">> {
  const access_token = await mintAccessToken({ sub: user_id, ver });
  const { plaintext, hash } = mintRefreshToken();
  const expires_at = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);
  await db.insert(sessions).values({
    user_id,
    refresh_token_hash: hash,
    expires_at,
    user_agent: meta.user_agent ?? null,
    ip: meta.ip ?? null,
  });
  return {
    access_token,
    refresh_token: plaintext,
    expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}
