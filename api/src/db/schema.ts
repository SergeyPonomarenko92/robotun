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
  date,
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

/**
 * Module 5 — listings (MVP cut, see service comment for scope).
 *
 * Reduced from spec-architecture-listings.md: no in_review/admin moderation,
 * no reports/appeals/snapshots/audit-partitioned/bulk-jobs/geo-refs/FTS-
 * dictionary. trusted=everyone (auto-active on publish). Cover/gallery as
 * URL strings — Module 6 Media will replace with FK arrays.
 */
export const listingStatusEnum = pgEnum("listing_status", [
  "draft",
  "in_review",
  "active",
  "paused",
  "archived",
]);

export const listingPricingTypeEnum = pgEnum("listing_pricing_type", [
  "fixed",
  "hourly",
  "range",
  "starting_from",
  "discuss",
]);

export const listingServiceTypeEnum = pgEnum("listing_service_type", [
  "on_site",
  "remote",
  "both",
]);

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider_id: uuid("provider_id").references(() => users.id, { onDelete: "set null" }),
    category_id: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: listingStatusEnum("status").notNull().default("draft"),
    pricing_type: listingPricingTypeEnum("pricing_type").notNull(),
    /** Stored as minor units (kopecks) per CLAUDE.md "Money as integer minor units". */
    price_amount: integer("price_amount"),
    price_amount_max: integer("price_amount_max"),
    currency: text("currency"),
    service_type: listingServiceTypeEnum("service_type").notNull().default("both"),
    city: text("city"),
    region: text("region"),
    tags: text("tags").array().notNull().default([]),
    cover_url: text("cover_url"),
    gallery_urls: text("gallery_urls").array().notNull().default([]),
    response_sla_minutes: integer("response_sla_minutes"),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    published_at: timestamp("published_at", { withTimezone: true }),
    archived_at: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    activeCursorIdx: index("idx_listings_active_cursor").on(t.published_at, t.id),
    providerStatusIdx: index("idx_listings_provider_status").on(t.provider_id, t.status, t.created_at),
    categoryActiveIdx: index("idx_listings_category_active").on(t.category_id, t.status, t.published_at),
  })
);

/**
 * Wizard autosave storage. Ephemeral / capped-per-user. Distinct from
 * listings.status='draft' which is the spec model — this table is a UI
 * convenience for the multi-step wizard before commit-to-listing.
 */
export const listingDrafts = pgTable(
  "listing_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("idx_listing_drafts_owner").on(t.owner_user_id, t.updated_at),
  })
);

export const providerListingCaps = pgTable("provider_listing_caps", {
  provider_id: uuid("provider_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  active_count: integer("active_count").notNull().default(0),
  draft_count: integer("draft_count").notNull().default(0),
  created_today: integer("created_today").notNull().default(0),
  today_date: date("today_date").notNull().defaultNow(),
});

/**
 * Module 6 — Media pipeline (MVP cut).
 *
 * In scope: media_objects (listing_cover/listing_gallery/avatar purposes
 * only), listing_media link table. State machine awaiting_upload →
 * awaiting_scan → ready directly (no async clamav scan in MVP — TODO).
 * Quarantine bucket = direct PUT/POST from client; on confirm we HEAD and
 * mark ready. KYC/message/dispute purposes deferred to their owning modules.
 * No variants/thumbnails (single original). No rate limiter table.
 */
export const mediaPurposeEnum = pgEnum("media_purpose", [
  "listing_cover",
  "listing_gallery",
  "listing_attachment",
  "kyc_document",
  "avatar",
  "message_attachment",
  "dispute_evidence",
]);

export const mediaBucketEnum = pgEnum("media_bucket", [
  "quarantine",
  "public-media",
  "kyc-private",
]);

export const mediaStatusEnum = pgEnum("media_status", [
  "awaiting_upload",
  "awaiting_scan",
  "ready",
  "scan_error",
  "scan_error_permanent",
  "quarantine_rejected",
  "deleted",
]);

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner_user_id: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    listing_id: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    /** kyc_document_id / message_id / dispute_evidence_id columns ship now
     *  without FK — added by their owning modules' deploy migrations
     *  (Module 4 / Module 10 / Module 14). */
    kyc_document_id: uuid("kyc_document_id"),
    message_id: uuid("message_id"),
    dispute_evidence_id: uuid("dispute_evidence_id"),
    purpose: mediaPurposeEnum("purpose").notNull(),
    storage_key: text("storage_key").notNull(),
    bucket_alias: mediaBucketEnum("bucket_alias").notNull(),
    original_filename: text("original_filename"),
    mime_type: text("mime_type").notNull(),
    byte_size: integer("byte_size").notNull(),
    checksum_sha256: text("checksum_sha256"),
    width_px: integer("width_px"),
    height_px: integer("height_px"),
    is_public: boolean("is_public").notNull().default(false),
    status: mediaStatusEnum("status").notNull().default("awaiting_upload"),
    scan_attempts: smallint("scan_attempts").notNull().default(0),
    last_scan_error: text("last_scan_error"),
    scan_error_at: timestamp("scan_error_at", { withTimezone: true }),
    scan_completed_at: timestamp("scan_completed_at", { withTimezone: true }),
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    ready_at: timestamp("ready_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    hard_deleted_at: timestamp("hard_deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("idx_media_objects_owner").on(t.owner_user_id),
    listingIdx: index("idx_media_objects_listing").on(t.listing_id),
    orphanIdx: index("idx_media_objects_orphan").on(t.created_at),
  })
);

export const listingMedia = pgTable(
  "listing_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listing_id: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    media_id: uuid("media_id")
      .notNull()
      .references(() => mediaObjects.id),
    display_order: smallint("display_order").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    listingUniq: uniqueIndex("uq_listing_media").on(t.listing_id, t.media_id),
    orderIdx: index("idx_listing_media_order").on(t.listing_id, t.display_order),
  })
);

/**
 * Module 4 — KYC provider verification (MVP cut).
 *
 * In scope: state machine (not_submitted → submitted → in_review →
 * approved/rejected), submission cap with 24h cooling-off after rejection,
 * denormalization to users.kyc_status, document metadata. Documents are
 * uploaded via Module 6 Media pipeline with purpose='kyc_document'
 * (bucket=kyc-private).
 *
 * Out of scope (TODO): encryption-at-rest of PII (document_number_enc /
 * full_name_enc remain NULL), partitioned kyc_review_events (non-
 * partitioned MVP), expired/stale-claim/rekyc sweeps, provider_profiles
 * table (mfa+payout fields live on users for now).
 */
export const kycVerificationStatusEnum = pgEnum("kyc_verification_status", [
  "not_submitted",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export const kycVerifications = pgTable(
  "kyc_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider_id: uuid("provider_id")
      .references(() => users.id, { onDelete: "set null" }),
    status: kycVerificationStatusEnum("status").notNull().default("not_submitted"),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    review_started_at: timestamp("review_started_at", { withTimezone: true }),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    rejection_code: text("rejection_code"),
    rejection_note: text("rejection_note"),
    rekyc_required_reason: text("rekyc_required_reason"),
    rekyc_required_at: timestamp("rekyc_required_at", { withTimezone: true }),
    reviewed_by: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    submission_count: integer("submission_count").notNull().default(0),
    submission_limit: integer("submission_limit").notNull().default(5),
    last_decided_at: timestamp("last_decided_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerUniq: uniqueIndex("uq_kyc_provider").on(t.provider_id),
    statusQueueIdx: index("idx_kyc_status_queue").on(t.created_at, t.status),
  })
);

export const kycDocumentTypeEnum = pgEnum("kyc_document_type", [
  "passport_ua",
  "passport_foreign",
  "id_card",
  "rnokpp",
  "fop_certificate",
  "selfie",
]);

export const kycDocVerificationEnum = pgEnum("kyc_doc_verification_status", [
  "pending",
  "accepted",
  "rejected",
]);

export const kycDocuments = pgTable(
  "kyc_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kyc_verification_id: uuid("kyc_verification_id")
      .notNull()
      .references(() => kycVerifications.id, { onDelete: "restrict" }),
    provider_id: uuid("provider_id").references(() => users.id, { onDelete: "set null" }),
    document_type: kycDocumentTypeEnum("document_type").notNull(),
    media_id: uuid("media_id").references(() => mediaObjects.id, { onDelete: "set null" }),
    /** PII columns kept for forward-compat with KMS encryption layer; NULL in MVP. */
    document_number_enc: text("document_number_enc"),
    full_name_enc: text("full_name_enc"),
    date_of_birth_enc: text("date_of_birth_enc"),
    kek_version: text("kek_version").notNull().default("v1"),
    document_expires_at: date("document_expires_at"),
    verification_status: kycDocVerificationEnum("verification_status").notNull().default("pending"),
    rejection_reason: text("rejection_reason"),
    submission_index: integer("submission_index").notNull(),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => ({
    verificationIdx: index("idx_kyc_docs_verification").on(t.kyc_verification_id, t.submission_index),
    providerIdx: index("idx_kyc_docs_provider").on(t.provider_id, t.uploaded_at),
  })
);

/** Non-partitioned MVP; full spec wants monthly partitions. */
export const kycReviewEvents = pgTable(
  "kyc_review_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kyc_verification_id: uuid("kyc_verification_id").notNull(),
    provider_id: uuid("provider_id"),
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actor_role: text("actor_role").notNull(),
    event_type: text("event_type").notNull(),
    from_status: text("from_status"),
    to_status: text("to_status"),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kvIdx: index("idx_kyc_events_kv").on(t.kyc_verification_id, t.created_at),
  })
);
