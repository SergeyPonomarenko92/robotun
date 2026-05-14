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
  smallint,
  bigserial,
  jsonb,
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

/**
 * Module 10 — categories (DAT-001).
 *
 * Adjacency-list tree capped at depth 3 (level ∈ {1,2,3}). Triggers
 * (level enforce / deny reparent / deny delete / pending-slug cross-check
 * / set updated_at) live in 0001_categories.sql — drizzle-kit cannot
 * generate them.
 */
export const categoryStatusEnum = pgEnum("category_status", ["active", "archived"]);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parent_id: uuid("parent_id"),
    level: smallint("level").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: categoryStatusEnum("status").notNull().default("active"),
    creator_id: uuid("creator_id").references(() => users.id, { onDelete: "set null" }),
    admin_created: boolean("admin_created").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    parentActiveIdx: index("idx_categories_parent_active").on(t.parent_id),
  })
);

export const categoryProposalStatusEnum = pgEnum("category_proposal_status", [
  "pending",
  "approved",
  "rejected",
  "auto_rejected",
]);

export const categoryProposals = pgTable(
  "category_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposer_id: uuid("proposer_id").references(() => users.id, { onDelete: "set null" }),
    parent_category_id: uuid("parent_category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    proposed_name: text("proposed_name").notNull(),
    proposed_slug: text("proposed_slug").notNull(),
    status: categoryProposalStatusEnum("status").notNull().default("pending"),
    reviewed_by: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    rejection_code: text("rejection_code"),
    rejection_note: text("rejection_note"),
    auto_rejected: boolean("auto_rejected").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCreatedIdx: index("idx_proposals_status_created").on(t.status, t.created_at),
    proposerIdx: index("idx_proposals_proposer").on(t.proposer_id, t.created_at),
  })
);

export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "processed", "failed"]);

/**
 * Shared transactional outbox (Module 10 §4.3). First spec to formally define
 * it; consumed by Feed/Search/Notifications workers (to be built).
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    aggregate_type: text("aggregate_type").notNull(),
    aggregate_id: uuid("aggregate_id").notNull(),
    event_type: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempt_count: smallint("attempt_count").notNull().default(0),
    next_retry_at: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processed_at: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    pendingReadyIdx: index("idx_outbox_pending_ready").on(t.next_retry_at),
    aggregateIdx: index("idx_outbox_aggregate").on(t.aggregate_type, t.aggregate_id),
  })
);
