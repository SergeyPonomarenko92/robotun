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
  return {
    id: kv.id,
    status: kv.status,
    submitted_at: kv.submitted_at?.toISOString() ?? null,
    review_started_at: kv.review_started_at?.toISOString() ?? null,
    decided_at: kv.decided_at?.toISOString() ?? null,
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

export async function submitKyc(args: {
  provider_id: string;
  documents: SubmitDoc[];
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

export async function listAdminQueue(opts: { limit: number }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const rows = await db
    .select()
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.status, "submitted"),
        dsql`${kycVerifications.reviewed_by} IS NULL`
      )
    )
    .orderBy(kycVerifications.created_at)
    .limit(limit);
  return { items: rows };
}

export async function claim(args: { kyc_id: string; admin_id: string }): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; status: string; provider_id: string | null }>(
      dsql`SELECT id, status, provider_id FROM kyc_verifications WHERE id = ${args.kyc_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    const row = r[0]!;
    if (row.status !== "submitted") return err("not_claimable", 409, { current_status: row.status });

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
    });

    return { ok: true as const, value: { id: args.kyc_id } };
  });
}

export async function approve(args: { kyc_id: string; admin_id: string }): Promise<Result<{ id: string }>> {
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
      dsql`UPDATE users SET kyc_approved_at = COALESCE(kyc_approved_at, ${now})
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
