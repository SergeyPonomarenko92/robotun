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
  real,
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
    email_verified_at: timestamp("email_verified_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    status: userStatusEnum("status").notNull().default("pending"),
    kyc_status: kycStatusEnum("kyc_status").notNull().default("none"),
    payout_enabled: boolean("payout_enabled").notNull().default(false),
    has_provider_role: boolean("has_provider_role").notNull().default(false),
    mfa_enrolled: boolean("mfa_enrolled").notNull().default(false),
    totp_secret: text("totp_secret"),
    /** Denorm of "the moment this provider was KYC-approved". Set by
     *  kyc.service.approve, NEVER cleared on revoke/re-submission. Used
     *  by Feed for snapshot-stable cursor ranking (kyc_verifications
     *  mutates status in place so it can't provide the historical signal). */
    kyc_approved_at: timestamp("kyc_approved_at", { withTimezone: true }),
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
export const totpRecoveryCodes = pgTable(
  "totp_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code_hash: text("code_hash").notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUniq: uniqueIndex("uq_totp_recovery_codes_hash").on(t.code_hash),
    userIdx: index("idx_totp_recovery_codes_user").on(t.user_id),
  })
);

export const authAuditEvents = pgTable(
  "auth_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    event_type: text("event_type").notNull(),
    ip: text("ip"),
    user_agent: text("user_agent"),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("idx_auth_audit_user").on(t.user_id, t.created_at),
    eventTypeIdx: index("idx_auth_audit_event_type").on(t.event_type, t.created_at),
  })
);

export const emailChangeTokens = pgTable(
  "email_change_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    new_email: text("new_email").notNull(),
    token_hash: text("token_hash").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUniq: uniqueIndex("uq_email_change_tokens_hash").on(t.token_hash),
    userIdx: index("idx_email_change_tokens_user").on(t.user_id),
  })
);

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUniq: uniqueIndex("uq_email_verification_tokens_hash").on(t.token_hash),
    userIdx: index("idx_email_verification_tokens_user").on(t.user_id),
  })
);

export const deletedUserIndex = pgTable(
  "deleted_user_index",
  {
    user_id: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    email_hash: text("email_hash").notNull(),
    purge_after: timestamp("purge_after", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailHashIdx: index("idx_deleted_user_index_email_hash").on(t.email_hash),
    purgeIdx: index("idx_deleted_user_index_purge_after").on(t.purge_after),
  })
);

export const providerProfiles = pgTable(
  "provider_profiles",
  {
    user_id: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    kyc_status: kycStatusEnum("kyc_status").notNull().default("none"),
    payout_enabled: boolean("payout_enabled").notNull().default(false),
    headline: text("headline"),
    service_area: text("service_area"),
    completed_deals_count: integer("completed_deals_count").notNull().default(0),
    avg_rating: real("avg_rating"),
    review_count: integer("review_count").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kycIdx: index("idx_provider_profiles_kyc").on(t.kyc_status),
  })
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
    ip: text("ip"),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUniq: uniqueIndex("uq_password_reset_tokens_hash").on(t.token_hash),
    userIdx: index("idx_password_reset_tokens_user").on(t.user_id),
  })
);

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
    // sharp-generated 256x256 webp thumbnail; same bucket, key suffix
    // `__thumb.webp`. LEGACY — kept for one cycle, read from `variants`.
    thumbnail_key: text("thumbnail_key"),
    // sharp-generated 640px-wide webp preview; LEGACY — read from `variants`.
    preview_key: text("preview_key"),
    // Canonical variants map: { thumbnail, preview, ... }. Future @2x sizes
    // land here without further schema migrations.
    variants: jsonb("variants").notNull().default({}),
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

/**
 * Module 3 — Deal workflow (MVP cut).
 *
 * State machine: pending → active → in_review → completed | disputed | cancelled.
 * Escrow stays as fields/columns but transitions don't gate on Payments — /accept
 * activates synchronously (TODO Module 11 will route through escrow callback).
 *
 * Out of scope (TODO): auto-completion 7d cron, dispute escalation, pending-expiry
 * 72h sweep, admin /resolve (Module 14), provider_profiles.completed_deals_count
 * trigger (provider_profiles table not yet built), dispute_escalations,
 * deal_attachments (defer to Module 6 media linkage).
 */
export const dealStatusEnum = pgEnum("deal_status", [
  "pending",
  "active",
  "in_review",
  "completed",
  "disputed",
  "cancelled",
]);

export const escrowStatusEnum = pgEnum("escrow_status", [
  "not_required",
  "hold_requested",
  "held",
  "release_requested",
  "released",
  "refund_requested",
  "refunded",
]);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    client_id: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider_id: uuid("provider_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    listing_id: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    category_id: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: dealStatusEnum("status").notNull().default("pending"),
    /** kopecks (UAH minor units) */
    agreed_price: integer("agreed_price").notNull(),
    currency: text("currency").notNull().default("UAH"),
    escrow_status: escrowStatusEnum("escrow_status").notNull().default("not_required"),
    escrow_hold_id: uuid("escrow_hold_id"),
    escrow_hold_requested_at: timestamp("escrow_hold_requested_at", { withTimezone: true }),
    escrow_held_at: timestamp("escrow_held_at", { withTimezone: true }),
    escrow_released_at: timestamp("escrow_released_at", { withTimezone: true }),
    deadline_at: timestamp("deadline_at", { withTimezone: true }),
    review_started_at: timestamp("review_started_at", { withTimezone: true }),
    auto_complete_after: timestamp("auto_complete_after", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    dispute_window_until: timestamp("dispute_window_until", { withTimezone: true }),
    dispute_opened_at: timestamp("dispute_opened_at", { withTimezone: true }),
    dispute_resolve_by: timestamp("dispute_resolve_by", { withTimezone: true }),
    cancel_requested_by_client_at: timestamp("cancel_requested_by_client_at", { withTimezone: true }),
    cancel_requested_by_provider_at: timestamp("cancel_requested_by_provider_at", { withTimezone: true }),
    cancellation_reason: text("cancellation_reason"),
    resolution_outcome: text("resolution_outcome"),
    resolution_release_amount: integer("resolution_release_amount"),
    resolution_note: text("resolution_note"),
    resolved_by_admin_id: uuid("resolved_by_admin_id").references(() => users.id, { onDelete: "set null" }),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    idempotency_key: text("idempotency_key"),
    idempotency_body_hash: text("idempotency_body_hash"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index("idx_deals_client").on(t.client_id, t.status, t.created_at),
    providerIdx: index("idx_deals_provider").on(t.provider_id, t.status, t.created_at),
    listingIdx: index("idx_deals_listing").on(t.listing_id),
    idempUniq: uniqueIndex("uq_deals_idempotency_key").on(t.idempotency_key),
  })
);

export const dealEvents = pgTable(
  "deal_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "restrict" }),
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actor_role: text("actor_role").notNull(),
    event_type: text("event_type").notNull(),
    from_status: text("from_status"),
    to_status: text("to_status"),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dealIdx: index("idx_deal_events_deal").on(t.deal_id, t.created_at),
    actorIdx: index("idx_deal_events_actor").on(t.actor_id, t.created_at),
  })
);

/**
 * Module 7 — Reviews (MVP cut).
 *
 * One review per (deal, reviewer_role). Client reviews provider (4 rating
 * sub-scores); provider reviews client (overall only). Reply: single reply
 * per review.
 *
 * Out of scope (TODO): blind-double-review mechanism (we publish+reveal
 * immediately instead of waiting for both-submitted or 14d sweep), RLS,
 * review_reply_audit history, review_reports moderation queue, GDPR
 * PII NULL'ing, aggregate denorm columns on listings/provider_profiles.
 */
export const reviewStatusEnum = pgEnum("review_status", [
  "pending",
  "published",
  "hidden",
  "removed",
]);

export const reviewerRoleEnum = pgEnum("review_reviewer_role", ["client", "provider"]);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "restrict" }),
    listing_id: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    reviewer_id: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    reviewee_id: uuid("reviewee_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewer_role: reviewerRoleEnum("reviewer_role").notNull(),
    overall_rating: smallint("overall_rating").notNull(),
    quality_rating: smallint("quality_rating"),
    communication_rating: smallint("communication_rating"),
    timeliness_rating: smallint("timeliness_rating"),
    comment: text("comment"),
    status: reviewStatusEnum("status").notNull().default("published"),
    both_submitted: boolean("both_submitted").notNull().default(false),
    submitted_at: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    revealed_at: timestamp("revealed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dealRoleUniq: uniqueIndex("uq_review_deal_role").on(t.deal_id, t.reviewer_role),
    listingPubIdx: index("idx_reviews_listing_published").on(t.listing_id, t.revealed_at),
    revieweePubIdx: index("idx_reviews_reviewee_published").on(t.reviewee_id, t.revealed_at),
    dealIdx: index("idx_reviews_deal").on(t.deal_id),
  })
);

export const reviewReplies = pgTable(
  "review_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    review_id: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "restrict" }),
    author_id: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    status: text("status").notNull().default("published"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reviewUniq: uniqueIndex("uq_one_reply_per_review").on(t.review_id),
    authorIdx: index("idx_review_replies_author").on(t.author_id),
  })
);

/**
 * Module 9 — Notifications (MVP cut).
 *
 * Polling worker (services/notifications-worker.ts) scans outbox_events
 * for pending rows, maps event_type → notification_code, resolves
 * recipient(s), writes notifications rows. Channels: in_app only (email
 * worker deferred). Preferences: per (user, code, channel) toggle.
 *
 * Out of scope: email/SMS delivery, batching/digests, push, GDPR PII
 * scrub at retention, Redis unread-count cache.
 */
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "skipped",
]);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    last_failed_at: timestamp("last_failed_at", { withTimezone: true }),
    failure_count: smallint("failure_count").notNull().default(0),
  },
  (t) => ({
    endpointUniq: uniqueIndex("uq_push_subscriptions_endpoint").on(t.endpoint),
    userIdx: index("idx_push_subscriptions_user").on(t.user_id),
  })
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipient_user_id: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source_event_id: integer("source_event_id"),
    aggregate_type: text("aggregate_type").notNull(),
    aggregate_id: uuid("aggregate_id").notNull(),
    notification_code: text("notification_code").notNull(),
    channel: text("channel").notNull().default("in_app"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: notificationStatusEnum("status").notNull().default("sent"),
    delivery_attempts: smallint("delivery_attempts").notNull().default(0),
    next_retry_at: timestamp("next_retry_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    read_at: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    recipientIdx: index("idx_notifications_recipient").on(t.recipient_user_id, t.created_at),
    dedupUniq: uniqueIndex("uq_notifications_dedup").on(
      t.source_event_id,
      t.recipient_user_id,
      t.channel,
      t.notification_code
    ),
  })
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notification_code: text("notification_code").notNull(),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("uq_pref_user_code_channel").on(t.user_id, t.notification_code, t.channel),
  })
);

/**
 * Module 2 — Messaging (MVP cut).
 *
 * Two scopes: pre_deal (Client→Provider via listing inquiry) and deal
 * (active/disputed deal scope). Single conversation per (client,
 * provider, scope_anchor) per spec. MVP: polling-based reads (SSE
 * deferred), no contact-info detection / moderation / attachments,
 * simple last_read_at per participant.
 */
export const conversationKindEnum = pgEnum("conversation_kind", ["pre_deal", "deal"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "blocked", "archived"]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: conversationKindEnum("kind").notNull(),
    /** pre_deal anchors on listing_id; deal anchors on deal_id. */
    listing_id: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    deal_id: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    client_id: uuid("client_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    provider_id: uuid("provider_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    status: conversationStatusEnum("status").notNull().default("open"),
    last_message_at: timestamp("last_message_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index("idx_conversations_client").on(t.client_id, t.last_message_at),
    providerIdx: index("idx_conversations_provider").on(t.provider_id, t.last_message_at),
    listingPairUniq: uniqueIndex("uq_conv_pre_deal").on(t.kind, t.listing_id, t.client_id),
    dealUniq: uniqueIndex("uq_conv_deal").on(t.kind, t.deal_id),
  })
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversation_id: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    sender_id: uuid("sender_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    convIdx: index("idx_messages_conv").on(t.conversation_id, t.created_at),
  })
);

export const conversationReads = pgTable(
  "conversation_reads",
  {
    conversation_id: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    last_read_at: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("uq_conv_reads").on(t.conversation_id, t.user_id),
  })
);

/**
 * Module 11 — Payments (MVP cut).
 *
 * Drastic simplification: no PSP integration, no escrow/ledger tables.
 * "Payment" per deal is a VIEW over deals state — held when active/in_review,
 * released on completed, refunded on cancelled-from-active. Only the
 * provider-side payout flow gets a real table (withdraw requests).
 *
 * Out of scope (TODO): LiqPay/Fondy/Stripe stubs, double-entry ledger
 * (PAY-PAT-001), pre-auth holds with TTL, chargeback flow,
 * reconciliation locks, KYC payout gate (enforced inline), manual
 * review threshold, fee accounting, refunds workflow.
 */
export const payoutStatusEnum = pgEnum("payout_status", [
  "requested",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider_id: uuid("provider_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    amount_kopecks: integer("amount_kopecks").notNull(),
    /** Masked card / IBAN tail for display only. */
    target_last4: text("target_last4"),
    status: payoutStatusEnum("status").notNull().default("requested"),
    failure_reason: text("failure_reason"),
    requested_at: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    providerIdx: index("idx_payouts_provider").on(t.provider_id, t.requested_at),
  })
);

/**
 * Module 14 — Disputes (MVP cut).
 *
 * One dispute_evidence row per party per deal. Admin /resolve transitions
 * disputed → completed (release_to_provider) or → cancelled (refund or
 * split). GDPR: statement NULLable to support erasure (CHECK with
 * length-OR-NULL).
 */
export const disputePartyRoleEnum = pgEnum("dispute_party_role", ["client", "provider"]);

export const disputeEvidence = pgTable(
  "dispute_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deal_id: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "restrict" }),
    party_role: disputePartyRoleEnum("party_role").notNull(),
    uploader_user_id: uuid("uploader_user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    statement: text("statement"),
    attachment_ids: jsonb("attachment_ids").notNull().default([]),
    submitted_at: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    gdpr_erased_at: timestamp("gdpr_erased_at", { withTimezone: true }),
  },
  (t) => ({
    dealPartyUniq: uniqueIndex("uq_dispute_evidence_deal_role").on(t.deal_id, t.party_role),
    dealIdx: index("idx_dispute_evidence_deal").on(t.deal_id),
  })
);

/**
 * Module 12 — Admin tooling (MVP cut).
 *
 * Immutable admin_actions audit table. Unified queue assembled at read
 * time from existing module tables (category_proposals.pending +
 * kyc_verifications.submitted). No 4-eyes approval, no MFA challenge,
 * no admin_sessions short-TTL, no bulk operations, no permission matrix
 * RBAC (relies on user_roles role check).
 */
export const adminActions = pgTable(
  "admin_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actor_admin_id: uuid("actor_admin_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    target_user_id: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    target_aggregate_type: text("target_aggregate_type"),
    target_aggregate_id: uuid("target_aggregate_id"),
    action: text("action").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ip: text("ip"),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index("idx_admin_actions_actor").on(t.actor_admin_id, t.created_at),
    targetUserIdx: index("idx_admin_actions_target_user").on(t.target_user_id, t.created_at),
  })
);
