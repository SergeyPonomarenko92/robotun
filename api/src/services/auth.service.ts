/**
 * Module 1 §4 — auth business logic. Pure functions over the db layer
 * so route handlers stay thin.
 */
import { eq, and, isNull, gt, desc, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, userRoles, users } from "../db/schema.js";
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

export async function logout(refreshToken: string): Promise<void> {
  const hash = sha256Hex(refreshToken);
  await db
    .update(sessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(sessions.refresh_token_hash, hash), isNull(sessions.revoked_at)));
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
