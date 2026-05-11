/**
 * Module 1 mock store — in-memory user/session DB for FE-only auth wiring.
 *
 * NOT a real auth implementation. When the real backend ships:
 *  - Replace these route handlers with real upstream proxy calls
 *  - Storage stays the same shape, just remove this file
 *  - JWT signing here is base64url-only (alg=none lookalike) — production
 *    requires RS256 with KMS-managed keys (Module 1 §3 Security).
 */

export type Role = "client" | "provider" | "admin";

export type MockUser = {
  id: string;
  email: string;
  /** Plaintext password is fine — mock only. Real backend uses argon2id (Module 1). */
  password: string;
  display_name: string;
  avatar_url?: string;
  email_verified: boolean;
  status: "pending" | "active" | "suspended" | "deleted";
  roles: Role[];
  kyc_status: "none" | "submitted" | "approved" | "rejected" | "expired";
  payout_enabled: boolean;
  has_provider_role: boolean;
  mfa_enrolled: boolean;
  /** Token version — bumped on logout-all / password change (Module 1 REQ). */
  ver: number;
  created_at: string;
};

export type MockSession = {
  /** SHA-256 hex of refresh token (mock: just identity since we only ever
   *  store this on the server side and compare against whole token). */
  refresh_token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  /** Once rotated/revoked — true. Replay returns 401. */
  revoked: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_MOCK__:
    | {
        users: Map<string, MockUser>;
        sessions: Map<string, MockSession>;
      }
    | undefined;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function bootstrap() {
  const users = new Map<string, MockUser>();
  const seed: Omit<MockUser, "id" | "created_at">[] = [
    {
      email: "client@robotun.dev",
      password: "demo1234",
      display_name: "Сергій П.",
      avatar_url: "https://i.pravatar.cc/120?img=51",
      email_verified: true,
      status: "active",
      roles: ["client"],
      kyc_status: "none",
      payout_enabled: false,
      has_provider_role: false,
      mfa_enrolled: false,
      ver: 1,
    },
    {
      email: "provider@robotun.dev",
      password: "demo1234",
      display_name: "Bosch Group Service",
      avatar_url: "https://i.pravatar.cc/120?img=12",
      email_verified: true,
      status: "active",
      roles: ["client", "provider"],
      kyc_status: "approved",
      payout_enabled: true,
      has_provider_role: true,
      mfa_enrolled: true,
      ver: 1,
    },
    {
      email: "admin@robotun.dev",
      password: "demo1234",
      display_name: "Admin · Robotun",
      avatar_url: "https://i.pravatar.cc/120?img=15",
      email_verified: true,
      status: "active",
      roles: ["admin"],
      kyc_status: "none",
      payout_enabled: false,
      has_provider_role: false,
      mfa_enrolled: true,
      ver: 1,
    },
  ];
  for (const u of seed) {
    const id = uuid();
    users.set(id, { ...u, id, created_at: new Date().toISOString() });
  }
  return { users, sessions: new Map<string, MockSession>() };
}

function db() {
  if (!globalThis.__ROBOTUN_MOCK__) {
    globalThis.__ROBOTUN_MOCK__ = bootstrap();
  }
  return globalThis.__ROBOTUN_MOCK__;
}

export const store = {
  findUserByEmail(email: string): MockUser | undefined {
    return Array.from(db().users.values()).find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
  },
  findUserById(id: string): MockUser | undefined {
    return db().users.get(id);
  },
  createUser(input: {
    email: string;
    password: string;
    initial_role: Role;
  }): MockUser {
    const id = uuid();
    const u: MockUser = {
      id,
      email: input.email,
      password: input.password,
      display_name: input.email.split("@")[0],
      email_verified: false,
      status: "pending",
      roles: [input.initial_role],
      kyc_status: "none",
      payout_enabled: false,
      has_provider_role: input.initial_role === "provider",
      mfa_enrolled: false,
      ver: 1,
      created_at: new Date().toISOString(),
    };
    db().users.set(id, u);
    return u;
  },
  bumpVersion(userId: string) {
    const u = db().users.get(userId);
    if (u) u.ver += 1;
  },
  createSession(userId: string): MockSession {
    const refresh = uuid() + uuid().replace(/-/g, "");
    const s: MockSession = {
      refresh_token: refresh,
      user_id: userId,
      created_at: new Date().toISOString(),
      expires_at: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString(),
      revoked: false,
    };
    db().sessions.set(refresh, s);
    // Module 1: max 10 active sessions per user — revoke oldest
    const userSessions = Array.from(db().sessions.values())
      .filter((x) => x.user_id === userId && !x.revoked)
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    if (userSessions.length > 10) {
      const oldest = userSessions[0];
      oldest.revoked = true;
    }
    return s;
  },
  rotateSession(oldRefresh: string): MockSession | null {
    const old = db().sessions.get(oldRefresh);
    if (!old || old.revoked) return null;
    if (new Date(old.expires_at).getTime() < Date.now()) return null;
    old.revoked = true;
    return store.createSession(old.user_id);
  },
  revokeSession(refresh: string) {
    const s = db().sessions.get(refresh);
    if (s) s.revoked = true;
  },
  revokeAllForUser(userId: string) {
    for (const s of db().sessions.values()) {
      if (s.user_id === userId) s.revoked = true;
    }
  },
};

/* =====================================================================
   Mock JWT — base64url encoded. NOT signed. Real backend uses RS256.
   Reading code on client just decodes the payload — tolerates this fine.
   ===================================================================== */

const ACCESS_TTL_SEC = 15 * 60;

function b64url(input: string): string {
  // Buffer is available in Next.js server runtime (node + edge)
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function mintAccessToken(user: MockUser): {
  access_token: string;
  expires_in: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "none", typ: "JWT" };
  const payload = {
    iss: "https://auth.robotun.dev",
    sub: user.id,
    iat: now,
    exp: now + ACCESS_TTL_SEC,
    jti: uuid(),
    roles: user.roles,
    mfa: user.mfa_enrolled,
    ver: user.ver,
  };
  const tok = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.`;
  return { access_token: tok, expires_in: ACCESS_TTL_SEC };
}

export function decodeAccessToken(token: string): {
  sub: string;
  exp: number;
  ver: number;
  roles: Role[];
} | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function authorize(
  authHeader: string | null
): { user: MockUser } | { error: string; status: number } {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "unauthorized", status: 401 };
  }
  const token = authHeader.slice(7);
  const claims = decodeAccessToken(token);
  if (!claims) return { error: "unauthorized", status: 401 };
  if (claims.exp * 1000 < Date.now())
    return { error: "token_expired", status: 401 };
  const user = store.findUserById(claims.sub);
  if (!user) return { error: "unauthorized", status: 401 };
  if (user.ver !== claims.ver)
    return { error: "token_expired", status: 401 };
  if (user.status === "deleted" || user.status === "suspended")
    return { error: "account_unavailable", status: 403 };
  return { user };
}

/* =====================================================================
   Public projection — what `/users/me` returns. Strips internals.
   ===================================================================== */
export function projectUser(u: MockUser) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    email_verified: u.email_verified,
    status: u.status,
    roles: u.roles,
    has_provider_role: u.has_provider_role,
    kyc_status: u.kyc_status,
    payout_enabled: u.payout_enabled,
    mfa_enrolled: u.mfa_enrolled,
  };
}
export type PublicUser = ReturnType<typeof projectUser>;
