/**
 * Module 1 — users + sessions tables.
 *
 * Mirrors spec-architecture-users-authentication.md §4. New modules
 * will append their tables to this same schema file (or split per module
 * if it gets unwieldy — split point ~600 LOC).
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const userStatusEnum = pgEnum("user_status", [
  "pending",
  "active",
  "suspended",
  "deleted",
]);

export const kycStatusEnum = pgEnum("kyc_status_t", [
  "none",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** argon2id hash of the password. NEVER plaintext. */
    password_hash: text("password_hash").notNull(),
    display_name: text("display_name").notNull(),
    avatar_url: text("avatar_url"),
    email_verified: boolean("email_verified").notNull().default(false),
    status: userStatusEnum("status").notNull().default("pending"),
    kyc_status: kycStatusEnum("kyc_status").notNull().default("none"),
    payout_enabled: boolean("payout_enabled").notNull().default(false),
    has_provider_role: boolean("has_provider_role").notNull().default(false),
    mfa_enrolled: boolean("mfa_enrolled").notNull().default(false),
    /** Token version. Bumped on logout-all / password change / suspend per
     *  spec §SEC-006 — invalidates all outstanding access tokens. */
    ver: integer("ver").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUniqIdx: uniqueIndex("users_email_lower_unique").on(t.email),
  })
);

export const userRolesEnum = pgEnum("user_role", [
  "client",
  "provider",
  "admin",
  "moderator",
  "support",
]);

export const userRoles = pgTable(
  "user_roles",
  {
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRolesEnum("role").notNull(),
    granted_at: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("user_roles_user_role_pk").on(t.user_id, t.role),
  })
);

/**
 * Refresh-token-keyed sessions per Module 1 AC-008. The token itself is
 * an opaque random string; we store only its SHA-256 hash. Each session
 * tracks `revoked` for rotation/replay-prevention.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the refresh token. The plaintext is delivered to
     *  the client exactly once on issue / rotation. */
    refresh_token_hash: text("refresh_token_hash").notNull(),
    user_agent: text("user_agent"),
    ip: text("ip"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set to now() when this refresh row has been rotated or explicitly
     *  revoked. Subsequent presentation of the original token → 401 +
     *  reuse alert per spec §4.3. */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    hashIdx: uniqueIndex("sessions_refresh_hash_unique").on(t.refresh_token_hash),
    userIdx: index("sessions_user_id_idx").on(t.user_id),
    expiresIdx: index("sessions_expires_idx").on(t.expires_at),
  })
);
