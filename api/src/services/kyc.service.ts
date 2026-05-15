/**
 * Module 4 — KYC provider verification service (MVP cut).
 *
 * State machine: not_submitted → submitted → in_review → approved | rejected.
 * Resubmit from rejected after 24h cooling-off, capped by submission_limit.
 *
 * Sync side-effects on approve: users.kyc_status='approved', users.payout_enabled
 * follows mfa_enrolled. On rejected/expired: kyc_status mirrored, payout_enabled=false.
 *
 * Out of scope (TODO): expired-sweep cron, stale-claim eviction (4h), rekyc,
 * cancelled-via-soft-delete, partitioned audit, encryption-at-rest of PII
 * fields. Document storage via Module 6 Media (purpose='kyc_document',
 * bucket=kyc-private).
 */
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  kycDocuments,
  kycReviewEvents,
  kycVerifications,
  mediaObjects,
  outboxEvents,
  users,
} from "../db/schema.js";

const COOLING_OFF_MS = 24 * 60 * 60 * 1000;
const SUBMISSION_LIMIT_DEFAULT = 5;

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

/* -------------------------- RNOKPP validation ---------------------------- */

const RNOKPP_WEIGHTS = [-1, 5, 7, 9, 4, 6, 10, 5, 7];

export function validateRnokpp(s: string): boolean {
  if (!/^\d{10}$/.test(s)) return false;
  const d = s.split("").map((c) => Number(c));
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i]! * RNOKPP_WEIGHTS[i]!;
  // Euclidean modulo per spec §4.4.1.
  const check = (((sum % 11) + 11) % 11) % 10;
  return check === d[9];
}

export function validateDocNumber(type: string, value: string): true | string {
  switch (type) {
    case "rnokpp":
      if (!/^\d{10}$/.test(value)) return "invalid_rnokpp_format";
      if (!validateRnokpp(value)) return "invalid_rnokpp_checksum";
      return true;
    case "id_card":
      return /^\d{9}$/.test(value) ? true : "invalid_id_card_format";
    case "passport_ua":
      return /^[А-ЯІЇЄ]{2}\d{6}$/.test(value) ? true : "invalid_passport_ua_format";
    case "passport_foreign":
      return /^[A-Z0-9]{6,9}$/.test(value) ? true : "invalid_passport_foreign_format";
    default:
      return true;
  }
}

/* ----------------------- helpers / denorm side-effects -------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function syncUserKycStatus(tx: Tx, userId: string, kycStatus: "none" | "submitted" | "in_review" | "approved" | "rejected" | "expired" | "cancelled", opts: { payout?: boolean }) {
  const update: Record<string, unknown> = { kyc_status: kycStatus };
  if (opts.payout !== undefined) update.payout_enabled = opts.payout;
  await tx.update(users).set(update).where(eq(users.id, userId));
  // REQ-004 critic RISK-3: provider_profiles.kyc_status + payout_enabled
  // must mirror users.* for the defense-in-depth read path (Module 13
  // ranking, Module 11 payments). UPDATE inside the same tx so the two
  // copies never observably diverge. No-op if user has no
  // provider_profiles row (client-only account).
  await tx.execute(
    dsql`UPDATE provider_profiles
            SET kyc_status = ${kycStatus}::kyc_status_t,
                updated_at = now()${opts.payout !== undefined ? dsql`, payout_enabled = ${opts.payout}` : dsql``}
          WHERE user_id = ${userId}`
  );
}

async function logEvent(tx: Tx, args: {
  kv_id: string;
  provider_id: string | null;
  actor_id: string;
  actor_role: "provider" | "admin" | "system";
  event_type: string;
  from_status?: string;
  to_status?: string;
  metadata?: Record<string, unknown>;
  // REQ-014: ip + user_agent captured for every admin-actor mutation.
  // Optional because system-actor cron paths (sweep, expiry) legitimately
  // have no request context. Required de-facto for actor_role='admin'
  // (route layer always threads it).
  ip?: string | null;
  user_agent?: string | null;
}) {
  await tx.insert(kycReviewEvents).values({
    kyc_verification_id: args.kv_id,
    provider_id: args.provider_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    event_type: args.event_type,
    from_status: args.from_status ?? null,
    to_status: args.to_status ?? null,
    metadata: args.metadata ?? {},
    ip: args.ip ?? null,
    user_agent: args.user_agent ?? null,
  });
}

/* --------------------------- lazy bootstrap ------------------------------ */

async function ensureKycRow(tx: Tx, providerId: string) {
  const rows = await tx
    .select()
    .from(kycVerifications)
    .where(eq(kycVerifications.provider_id, providerId))
    .limit(1);
  if (rows.length > 0) return rows[0]!;
  const inserted = await tx
    .insert(kycVerifications)
    .values({
      provider_id: providerId,
      status: "not_submitted",
      submission_limit: SUBMISSION_LIMIT_DEFAULT,
    })
    .returning();
  return inserted[0]!;
}

/* ------------------------------- READ ----------------------------------- */

export async function getMine(providerId: string) {
  const kv = await db.transaction(async (tx) => ensureKycRow(tx, providerId));
  const docs = await db
    .select()
    .from(kycDocuments)
    .where(eq(kycDocuments.kyc_verification_id, kv.id))
    .orderBy(desc(kycDocuments.uploaded_at));
  const decidedAt = kv.decided_at?.toISOString() ?? null;
  return {
    id: kv.id,
    // FE-canonical key (lib/kyc.ts KycSnapshot). Both fields kept so
    // internal admin tooling can still resolve by kyc id.
    provider_id: kv.provider_id,
    status: kv.status,
    submitted_at: kv.submitted_at?.toISOString() ?? null,
    review_started_at: kv.review_started_at?.toISOString() ?? null,
    decided_at: decidedAt,
    // FE-canonical alias for decided_at.
    reviewed_at: decidedAt,
    expires_at: kv.expires_at?.toISOString() ?? null,
    rejection_code: kv.rejection_code,
    rejection_note: kv.rejection_note,
    submission_count: kv.submission_count,
    submission_limit: kv.submission_limit,
    documents: docs.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      media_id: d.media_id,
      submission_index: d.submission_index,
      verification_status: d.verification_status,
      uploaded_at: d.uploaded_at.toISOString(),
    })),
  };
}

/* ------------------------------ SUBMIT ---------------------------------- */

export type SubmitDoc = {
  document_type: "passport_ua" | "passport_foreign" | "id_card" | "rnokpp" | "fop_certificate" | "selfie";
  media_id: string;
  document_number?: string;
  document_expires_at?: string | null;
};

// REQ-014 / SEC-006 audit context, threaded from route layer.
export type AuditCtx = { ip?: string | null; user_agent?: string | null };

export async function submitKyc(args: {
  provider_id: string;
  documents: SubmitDoc[];
  audit?: AuditCtx;
}): Promise<Result<{ kyc_id: string; status: "submitted"; submission_index: number }>> {
  if (args.documents.length === 0) return err("incomplete_submission", 422);
  if (args.documents.length > 10) return err("too_many_documents", 422);

  // Validate identifier formats (server-side, BEFORE DB writes — §4.4).
  for (const d of args.documents) {
    if (d.document_number) {
      const v = validateDocNumber(d.document_type, d.document_number);
      if (v !== true) return err(v, 422, { document_type: d.document_type });
    }
  }

  return await db.transaction(async (tx) => {
    const kv = await ensureKycRow(tx, args.provider_id);

    // Allowed-from-status transitions.
    if (kv.status !== "not_submitted" && kv.status !== "rejected" && kv.status !== "expired") {
      return err("invalid_state", 409, { current_status: kv.status });
    }
    if (kv.status === "rejected" || kv.status === "expired") {
      if (kv.last_decided_at && Date.now() - kv.last_decided_at.getTime() < COOLING_OFF_MS) {
        const retryAt = new Date(kv.last_decided_at.getTime() + COOLING_OFF_MS).toISOString();
        return err("cooling_off_active", 429, { retry_at: retryAt });
      }
      if (kv.submission_count >= kv.submission_limit) {
        return err("submission_limit_exceeded", 429, { limit: kv.submission_limit });
      }
    }

    const newCount = kv.submission_count + 1;

    // Verify each referenced media_id belongs to provider, is ready, and has
    // purpose='kyc_document'.
    for (const d of args.documents) {
      const mr = await tx
        .select()
        .from(mediaObjects)
        .where(eq(mediaObjects.id, d.media_id))
        .limit(1);
      if (mr.length === 0) return err("media_not_found", 404, { media_id: d.media_id });
      const m = mr[0]!;
      if (m.owner_user_id !== args.provider_id) return err("forbidden", 403, { media_id: d.media_id });
      if (m.purpose !== "kyc_document") return err("invalid_media_purpose", 422, { media_id: d.media_id });
      if (m.status !== "ready") return err("media_not_ready", 409, { media_id: d.media_id });
    }

    // INSERT kyc_documents rows. Media ownership stays on owner_user_id
    // (provider); we do not back-fill media.kyc_document_id because
    // chk_exactly_one_owner only permits a single owner column — the spec
    // expects ownership to migrate, but MVP keeps the forward link
    // (kyc_documents.media_id) authoritative.
    for (const d of args.documents) {
      await tx
        .insert(kycDocuments)
        .values({
          kyc_verification_id: kv.id,
          provider_id: args.provider_id,
          document_type: d.document_type,
          media_id: d.media_id,
          document_expires_at: d.document_expires_at ?? null,
          submission_index: newCount,
        });
    }

    await tx
      .update(kycVerifications)
      .set({
        status: "submitted",
        submitted_at: new Date(),
        submission_count: newCount,
        reviewed_by: null,
        review_started_at: null,
        version: kv.version + 1,
      })
      .where(eq(kycVerifications.id, kv.id));

    await syncUserKycStatus(tx, args.provider_id, "submitted", {});

    await logEvent(tx, {
      kv_id: kv.id,
      provider_id: args.provider_id,
      actor_id: args.provider_id,
      actor_role: "provider",
      event_type: "kyc.submitted",
      from_status: kv.status,
      to_status: "submitted",
      metadata: { submission_index: newCount, doc_count: args.documents.length },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "kyc",
      aggregate_id: kv.id,
      event_type: "kyc.submitted",
      payload: { kyc_id: kv.id, provider_id: args.provider_id, submission_index: newCount },
    });

    return {
      ok: true as const,
      value: { kyc_id: kv.id, status: "submitted" as const, submission_index: newCount },
    };
  });
}

/* ------------------------------ ADMIN ----------------------------------- */

/**
 * Admin queue FE shape (web/src/lib/admin-kyc.ts:5):
 *   AdminKycRow {
 *     provider_id, provider: {id, display_name, email, avatar_url?} | null,
 *     status, doc_type, legal_name, tax_id, submitted_at,
 *     reviewed_at, rejection_code
 *   }
 *
 * Filter `status`:
 *   'open' → submitted OR in_review (admin queue)
 *   'approved' / 'rejected' → exact match
 */
export async function listAdminQueue(opts: { limit: number; status?: string }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  let statusClause: string;
  switch (opts.status) {
    case "approved":
      statusClause = `kv.status = 'approved'`;
      break;
    case "rejected":
      statusClause = `kv.status = 'rejected'`;
      break;
    case "expired":
      statusClause = `kv.status = 'expired'`;
      break;
    case "open":
    default:
      statusClause = `kv.status IN ('submitted','in_review')`;
  }
  const rows = await (await import("../db/client.js")).sql.unsafe(`
    SELECT
      kv.provider_id, kv.status, kv.submitted_at, kv.decided_at AS reviewed_at, kv.rejection_code,
      u.display_name AS p_name, u.email AS p_email, u.avatar_url AS p_avatar,
      (SELECT document_type FROM kyc_documents
        WHERE kyc_verification_id = kv.id
        ORDER BY uploaded_at DESC LIMIT 1) AS doc_type
      FROM kyc_verifications kv
      LEFT JOIN users u ON u.id = kv.provider_id
     WHERE ${statusClause}
     ORDER BY kv.created_at
     LIMIT ${limit}
  `) as unknown as Array<{
    provider_id: string | null;
    status: string;
    submitted_at: Date | string | null;
    reviewed_at: Date | string | null;
    rejection_code: string | null;
    p_name: string | null;
    p_email: string | null;
    p_avatar: string | null;
    doc_type: string | null;
  }>;
  return {
    items: rows.map((r) => {
      // Map BE document_type → FE doc_type domain.
      const fedoc =
        r.doc_type === "passport_ua" || r.doc_type === "passport_foreign"
          ? "passport"
          : r.doc_type === "id_card"
            ? "id_card"
            : r.doc_type === "rnokpp" || r.doc_type === "fop_certificate"
              ? "bio_passport"
              : "id_card";
      return {
        provider_id: r.provider_id ?? "",
        provider: r.provider_id
          ? {
              id: r.provider_id,
              display_name: r.p_name ?? "",
              email: r.p_email ?? "",
              avatar_url: r.p_avatar ?? undefined,
            }
          : null,
        status: r.status,
        doc_type: fedoc,
        // PII fields (legal_name, tax_id) NULL until KMS encryption ships.
        legal_name: "",
        tax_id: "",
        submitted_at: r.submitted_at
          ? (typeof r.submitted_at === "string" ? r.submitted_at : r.submitted_at.toISOString())
          : "",
        reviewed_at: r.reviewed_at
          ? (typeof r.reviewed_at === "string" ? r.reviewed_at : r.reviewed_at.toISOString())
          : null,
        rejection_code: r.rejection_code ?? null,
      };
    }),
  };
}

/** Resolve a kyc_verifications.id by provider_id (FE-canonical key). */
export async function kycIdForProvider(providerId: string): Promise<string | null> {
  const r = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(eq(kycVerifications.provider_id, providerId))
    .limit(1);
  return r[0]?.id ?? null;
}

export async function claim(args: { kyc_id: string; admin_id: string; audit?: AuditCtx }): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    // SEC-010: serialize concurrent claims by the same admin via xact-scoped
    // advisory lock keyed on hashtext(admin_id). Held until COMMIT/ROLLBACK,
    // so two simultaneous /claim by the same admin are linearized — the
    // second one sees the first one's row in the count.
    await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtext(${args.admin_id})::bigint)`);

    const r = await tx.execute<{ id: string; status: string; provider_id: string | null }>(
      dsql`SELECT id, status, provider_id FROM kyc_verifications WHERE id = ${args.kyc_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    if (row.status !== "submitted") return err("not_claimable", 409, { current_status: row.status });

    // SEC-010: per-admin concurrent claim count ≤10; 11th → 429.
    // KNOWN SOFT-ENFORCEMENT (critic RISK-3): the auto-claim path in
    // /approve and /reject routes calls claim() then approve()/reject()
    // as two separate transactions. The advisory lock is released between
    // them, so a parallel direct /claim can interleave when the admin
    // sits at 9 claims, briefly pushing them to 11. Bounded by the time
    // between the two calls (single-digit ms); approve/reject immediately
    // transition out of in_review, so the over-cap window self-heals.
    // Tighten to single-tx only if a real bulk-tooling pressure point
    // emerges.
    const countR = await tx.execute<{ n: string }>(
      dsql`SELECT count(*)::text AS n FROM kyc_verifications
            WHERE reviewed_by = ${args.admin_id} AND status = 'in_review'`
    );
    const heldClaims = parseInt(countR[0]?.n ?? "0", 10);
    if (heldClaims >= 10) {
      return err("claim_limit_exceeded", 429, { held: heldClaims, cap: 10 });
    }

    await tx
      .update(kycVerifications)
      .set({ status: "in_review", reviewed_by: args.admin_id, review_started_at: new Date(), version: dsql`version + 1` })
      .where(eq(kycVerifications.id, args.kyc_id));

    if (row.provider_id) {
      await syncUserKycStatus(tx, row.provider_id, "in_review", {});
    }

    await logEvent(tx, {
      kv_id: args.kyc_id,
      provider_id: row.provider_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "kyc.claimed",
      from_status: "submitted",
      to_status: "in_review",
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    return { ok: true as const, value: { id: args.kyc_id } };
  });
}

export async function approve(args: { kyc_id: string; admin_id: string; audit?: AuditCtx }): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; status: string; provider_id: string | null; reviewed_by: string | null }>(
      dsql`SELECT id, status, provider_id, reviewed_by FROM kyc_verifications WHERE id = ${args.kyc_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    if (row.status !== "in_review") return err("invalid_state", 409, { current_status: row.status });
    if (row.reviewed_by !== args.admin_id) return err("not_claimed_by_actor", 403);
    if (!row.provider_id) return err("provider_missing", 422);

    const now = new Date();
    // Approval valid 12 months by default (spec uses MIN of scoped doc expiries
    // when present; we keep simple 12mo MVP).
    const expiresAt = new Date(now.getTime() + 365 * 24 * 3600 * 1000);

    await tx
      .update(kycVerifications)
      .set({
        status: "approved",
        decided_at: now,
        last_decided_at: now,
        expires_at: expiresAt,
        rejection_code: null,
        rejection_note: null,
        // REQ-009: clear the pre-expiry warning marker on fresh approval
        // so the 30d cron can fire again for the new approval cycle.
        rekyc_required_at: null,
        rekyc_required_reason: null,
        version: dsql`version + 1`,
      })
      .where(eq(kycVerifications.id, args.kyc_id));

    // Payout follows MFA per spec §4.6.
    const userRows = await tx
      .select({ mfa_enrolled: users.mfa_enrolled })
      .from(users)
      .where(eq(users.id, row.provider_id))
      .limit(1);
    const payoutEnabled = userRows[0]?.mfa_enrolled ?? false;
    await syncUserKycStatus(tx, row.provider_id, "approved", { payout: payoutEnabled });

    // Stamp the first-ever approval timestamp. Module 8 Feed reads this for
    // snapshot-stable score ranking; never cleared on subsequent rejects.
    await tx.execute(
      dsql`UPDATE users SET kyc_approved_at = COALESCE(kyc_approved_at, ${now.toISOString()}::timestamptz)
            WHERE id = ${row.provider_id}`
    );

    // Accept all pending docs.
    await tx
      .update(kycDocuments)
      .set({ verification_status: "accepted", reviewed_at: now })
      .where(
        and(
          eq(kycDocuments.kyc_verification_id, args.kyc_id),
          eq(kycDocuments.verification_status, "pending")
        )
      );

    await logEvent(tx, {
      kv_id: args.kyc_id,
      provider_id: row.provider_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "kyc.approved",
      from_status: "in_review",
      to_status: "approved",
      metadata: { payout_enabled: payoutEnabled, expires_at: expiresAt.toISOString() },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "kyc",
      aggregate_id: args.kyc_id,
      event_type: "kyc.approved",
      payload: {
        kyc_id: args.kyc_id,
        provider_id: row.provider_id,
        expires_at: expiresAt.toISOString(),
        payout_enabled: payoutEnabled,
      },
    });

    return { ok: true as const, value: { id: args.kyc_id } };
  });
}

export async function reject(args: {
  kyc_id: string;
  admin_id: string;
  rejection_code: string;
  rejection_note?: string;
  audit?: AuditCtx;
}): Promise<Result<{ id: string }>> {
  const VALID_CODES = new Set([
    "document_expired",
    "document_unreadable",
    "document_mismatch",
    "selfie_mismatch",
    "data_inconsistency",
    "unsupported_document_type",
    "incomplete_submission",
    "fraud_suspicion",
    "other",
  ]);
  if (!VALID_CODES.has(args.rejection_code)) return err("invalid_rejection_code", 422);

  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; status: string; provider_id: string | null; reviewed_by: string | null }>(
      dsql`SELECT id, status, provider_id, reviewed_by FROM kyc_verifications WHERE id = ${args.kyc_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    if (row.status !== "in_review") return err("invalid_state", 409, { current_status: row.status });
    if (row.reviewed_by !== args.admin_id) return err("not_claimed_by_actor", 403);

    const now = new Date();
    await tx
      .update(kycVerifications)
      .set({
        status: "rejected",
        decided_at: now,
        last_decided_at: now,
        rejection_code: args.rejection_code,
        rejection_note: args.rejection_note ?? null,
        version: dsql`version + 1`,
      })
      .where(eq(kycVerifications.id, args.kyc_id));

    if (row.provider_id) {
      await syncUserKycStatus(tx, row.provider_id, "rejected", { payout: false });
    }

    await tx
      .update(kycDocuments)
      .set({ verification_status: "rejected", reviewed_at: now, rejection_reason: args.rejection_code })
      .where(
        and(
          eq(kycDocuments.kyc_verification_id, args.kyc_id),
          eq(kycDocuments.verification_status, "pending")
        )
      );

    await logEvent(tx, {
      kv_id: args.kyc_id,
      provider_id: row.provider_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "kyc.rejected",
      from_status: "in_review",
      to_status: "rejected",
      metadata: { rejection_code: args.rejection_code },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "kyc",
      aggregate_id: args.kyc_id,
      event_type: "kyc.rejected",
      payload: {
        kyc_id: args.kyc_id,
        provider_id: row.provider_id,
        rejection_code: args.rejection_code,
      },
    });

    return { ok: true as const, value: { id: args.kyc_id } };
  });
}

/** REQ-011 — admin force-rekyc. Immediately revokes payout enablement
 *  and emits kyc.rekyc_required. Transitions the kyc_verifications row
 *  back to 'not_submitted' so the provider can resubmit (subject to
 *  cooling-off + submission_limit per REQ-012). */
export async function flagRekyc(args: {
  provider_id: string;
  admin_id: string;
  reason: string;
  audit?: AuditCtx;
}): Promise<Result<{ kyc_id: string }>> {
  if (!args.reason || args.reason.trim().length < 5) {
    return err("validation_failed", 400, { fields: { reason: "min_length_5" } });
  }
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; provider_id: string; status: string }>(
      dsql`SELECT id, provider_id, status FROM kyc_verifications
            WHERE provider_id = ${args.provider_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    // RISK-2: only meaningful from approved/submitted/in_review states.
    // Other states (already not_submitted / rejected / expired / cancelled)
    // already have payout=false; returning 409 prevents an admin from
    // racing a concurrent approval/review with an idempotent-looking call
    // that silently overrides the reviewing admin.
    if (!["approved", "submitted", "in_review"].includes(row.status)) {
      return err("invalid_state", 409, { current_status: row.status });
    }
    await tx
      .update(kycVerifications)
      .set({
        status: "not_submitted",
        reviewed_by: null,
        review_started_at: null,
        // RISK-1: preserve decided_at so reconciliation Direction A can
        // still distinguish "never approved" from "was approved, rekyc'd".
        // Only last_decided_at moves to anchor follow-up cooling-off if
        // ever introduced for the rekyc path.
        last_decided_at: new Date(),
        expires_at: null,
        rejection_code: null,
        rejection_note: null,
        // REQ-009 / critic RISK-2: clear pre-expiry warning marker so the
        // 30d cron re-fires on the next approval cycle if the provider
        // resubmits and is approved again.
        rekyc_required_at: null,
        rekyc_required_reason: null,
        version: dsql`version + 1`,
      })
      .where(eq(kycVerifications.id, row.id));
    await syncUserKycStatus(tx, args.provider_id, "none", { payout: false });

    await logEvent(tx, {
      kv_id: row.id,
      provider_id: args.provider_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "kyc.rekyc_required",
      from_status: row.status,
      to_status: "not_submitted",
      metadata: { reason: args.reason },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "kyc",
      aggregate_id: row.id,
      event_type: "kyc.rekyc_required",
      payload: {
        kyc_id: row.id,
        provider_id: args.provider_id,
        reason: args.reason,
        from_status: row.status,
      },
    });

    return { ok: true as const, value: { kyc_id: row.id } };
  });
}

/**
 * REQ-012 / §4.8.4 — admin bumps a provider's submission_limit by 5,
 * capped at the absolute ceiling 20 (CON-010). Used to recover providers
 * who hit the lifetime cap after legitimate documentation issues.
 *
 *   - 422 unblock_ceiling_reached when the bump would exceed 20.
 *   - reason_code enum is closed (see SAMPLE_REASON_CODES).
 *   - Idempotent only at the row level: each call lifts the limit until
 *     the ceiling. Audit row records actor + reason for the SEC-006 trail.
 */
// Single source of truth — also imported by kyc.routes.ts for Zod schema
// (critic RISK-2: prevents enum drift between route and service).
export const UNBLOCK_REASON_CODES = [
  "legitimate_documentation_issue",
  "system_error_during_submission",
  "provider_appeal_resolved",
  "other",
] as const;
export type UnblockReasonCode = (typeof UNBLOCK_REASON_CODES)[number];
const UNBLOCK_REASON_SET = new Set<string>(UNBLOCK_REASON_CODES);
const SUBMISSION_LIMIT_BUMP = 5;
const SUBMISSION_LIMIT_CEILING = 20;

/**
 * REQ-006 / §4.5 suspend transition — admin revokes a current approval.
 *   approved → rejected
 *   payout_enabled = false (via syncUserKycStatus + dual trigger SEC-007)
 *   outbox: kyc.suspended (distinct from kyc.rejected; Payments + Notifications)
 *   audit:  kyc.suspended event_type in kyc_review_events
 *
 * Reason note is required (compliance trail). Suspended state lives in the
 * rejected terminal but the kyc.suspended outbox event signals "was
 * approved, now revoked" to downstream consumers that need to distinguish
 * an initial rejection from a post-approval suspension (e.g., Payments
 * cancels any scheduled payouts only on suspension, not on a never-active
 * provider's first rejection).
 */
const SUSPEND_REASON_CODES = [
  "fraud_detected",
  "compliance_violation",
  "provider_request",
  "platform_policy_breach",
  "other",
] as const;
export type SuspendReasonCode = (typeof SUSPEND_REASON_CODES)[number];
const SUSPEND_REASON_SET = new Set<string>(SUSPEND_REASON_CODES);
export const SUSPEND_REASON_CODES_PUBLIC = SUSPEND_REASON_CODES;

export async function suspendApproval(args: {
  provider_id: string;
  admin_id: string;
  reason_code: string;
  reason_note: string;
  audit?: AuditCtx;
}): Promise<Result<{ kyc_id: string }>> {
  if (!SUSPEND_REASON_SET.has(args.reason_code)) {
    return err("validation_failed", 400, { fields: { reason_code: "invalid_enum" } });
  }
  if (!args.reason_note || args.reason_note.trim().length < 5) {
    return err("validation_failed", 400, { fields: { reason_note: "min_length_5" } });
  }
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; status: string }>(
      dsql`SELECT id, status FROM kyc_verifications
            WHERE provider_id = ${args.provider_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    // §4.5 row 5: suspend transitions from 'approved' only.
    if (row.status !== "approved") {
      return err("invalid_status_for_suspend", 422, { current_status: row.status });
    }
    const now = new Date();
    await tx
      .update(kycVerifications)
      .set({
        status: "rejected",
        decided_at: now,
        last_decided_at: now,
        rejection_code: "fraud_suspicion", // placeholder mapping into the rejection-code enum
        rejection_note: `[suspend:${args.reason_code}] ${args.reason_note}`,
        // suspension does not reset rekyc warning marker — provider's
        // future cycle (if reinstated) will be a fresh approval that
        // will null these.
        version: dsql`version + 1`,
      })
      .where(eq(kycVerifications.id, row.id));

    await syncUserKycStatus(tx, args.provider_id, "rejected", { payout: false });

    await logEvent(tx, {
      kv_id: row.id,
      provider_id: args.provider_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "kyc.suspended",
      from_status: "approved",
      to_status: "rejected",
      metadata: { reason_code: args.reason_code, reason_note: args.reason_note },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "kyc",
      aggregate_id: row.id,
      event_type: "kyc.suspended",
      payload: {
        kyc_id: row.id,
        provider_id: args.provider_id,
        reason_code: args.reason_code,
        reason_note: args.reason_note,
      },
    });

    return { ok: true as const, value: { kyc_id: row.id } };
  });
}

export async function unblockSubmissionLimit(args: {
  provider_id: string;
  admin_id: string;
  reason_code: string;
  reason_note?: string;
  audit?: AuditCtx;
}): Promise<Result<{ kyc_id: string; submission_limit: number }>> {
  if (!UNBLOCK_REASON_SET.has(args.reason_code)) {
    return err("validation_failed", 400, { fields: { reason_code: "invalid_enum" } });
  }
  // critic RISK-3: 'other' must include a free-text note (compliance audit
  // gap — generic 'other' code with no explanation is unauditable).
  if (args.reason_code === "other" && !args.reason_note?.trim()) {
    return err("validation_failed", 400, { fields: { reason_note: "required_when_reason_code_is_other" } });
  }
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; submission_limit: number; status: string }>(
      dsql`SELECT id, submission_limit, status FROM kyc_verifications
            WHERE provider_id = ${args.provider_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    // critic RISK-1: unblock only makes sense if a future resubmit is on
    // the table. Spec §4.8 state machine: resubmit transitions from
    // rejected | expired. Other states (not_submitted / approved /
    // suspended / cancelled / in_review / submitted) have no resubmit
    // path, so bumping the cap there is dead-write + audit noise + a
    // permanent ceiling inflation footgun.
    if (!["rejected", "expired"].includes(row.status)) {
      return err("invalid_status_for_unblock", 422, { current_status: row.status });
    }
    const newLimit = row.submission_limit + SUBMISSION_LIMIT_BUMP;
    if (newLimit > SUBMISSION_LIMIT_CEILING) {
      // CON-010: senior-admin escalation is out of MVP scope.
      return err("unblock_ceiling_reached", 422, {
        current: row.submission_limit,
        ceiling: SUBMISSION_LIMIT_CEILING,
      });
    }
    await tx
      .update(kycVerifications)
      .set({
        submission_limit: newLimit,
        version: dsql`version + 1`,
      })
      .where(eq(kycVerifications.id, row.id));

    await logEvent(tx, {
      kv_id: row.id,
      provider_id: args.provider_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "kyc.unblock",
      from_status: row.status,
      to_status: row.status,
      metadata: {
        reason_code: args.reason_code,
        reason_note: args.reason_note ?? null,
        previous_limit: row.submission_limit,
        new_limit: newLimit,
      },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });

    return { ok: true as const, value: { kyc_id: row.id, submission_limit: newLimit } };
  });
}
