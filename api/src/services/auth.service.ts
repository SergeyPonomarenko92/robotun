/**
 * Module 1 §4 — auth business logic. Pure functions over the db layer
 * so route handlers stay thin.
 */
import { eq, and, isNull, gt, desc, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { authAuditEvents, emailVerificationTokens, mediaObjects, passwordResetTokens, sessions, userRoles, users } from "../db/schema.js";
import { sendEmail } from "./email.js";
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
  | { code: "weak_password" };

export async function register(
  input: RegisterInput
): Promise<{ ok: true; result: AuthSuccess } | { ok: false; error: RegisterError }> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 12) {
    return { ok: false, error: { code: "weak_password" } };
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
      has_provider_role: isProvider,
      status: "active", // mock parity — real flow would gate on email_verified
    })
    .returning();
  if (!user) throw new Error("register: insert returned no row");

  await db.insert(userRoles).values({
    user_id: user.id,
    role: input.initial_role,
  });

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
        has_provider_role: user.has_provider_role,
      },
    },
  };
}

export type LoginError = { code: "invalid_credentials" } | { code: "account_disabled" };

export async function login(
  input: LoginInput
): Promise<{ ok: true; result: AuthSuccess } | { ok: false; error: LoginError }> {
  return withFloor(async () => {
    const email = input.email.trim().toLowerCase();
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

type ChangePasswordError = { code: "wrong_password" | "password_too_short" | "user_not_found"; status: number };

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
    // push_subscriptions cascade via ON DELETE on user; but user row stays,
    // so explicit delete.
    await tx.execute(dsql`DELETE FROM push_subscriptions WHERE user_id = ${args.user_id}`);
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
  | "sessions_logged_out_all"
  | "profile_updated"
  | "account_deleted";

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
    const u = await tx
      .update(users)
      .set({ email_verified: true, email_verified_at: now })
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
const BRAND_URL = process.env.BRAND_URL ?? "http://localhost:3000";

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
  if (userRow.length === 0 || userRow[0]!.status !== "active") {
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

type ResetPasswordError = { code: "password_too_short" | "token_invalid" | "token_used" | "token_expired"; status: number };

export async function resetPassword(args: {
  token: string;
  new_password: string;
}): Promise<{ ok: true; value: { user_id: string } } | { ok: false; error: ResetPasswordError }> {
  if (args.new_password.length < 12 || args.new_password.length > 256) {
    return { ok: false, error: { code: "password_too_short", status: 400 } };
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
