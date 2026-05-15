/**
 * Module 3 — Deal workflow service (MVP cut).
 *
 * State machine pending → active → in_review → completed|disputed|cancelled.
 * /accept transitions pending→active synchronously (TODO Module 11 will
 * gate via /internal/deals/{id}/escrow-held callback).
 *
 * Concurrency: each transition function does (a) SELECT … FOR UPDATE on the
 * deal row inside its transaction, (b) JS-side version check, (c) plain
 * UPDATE without a version predicate. The FOR UPDATE makes this effectively
 * pessimistic; the spec's PAT-001 calls for true optimistic (`UPDATE …
 * WHERE id=$id AND version=$v RETURNING …`). The implementation here is
 * intentionally pessimistic because the row contention is already low and
 * FOR UPDATE gives clearer error semantics — anyone refactoring towards
 * read-replica scaling MUST drop FOR UPDATE AND add `AND version=$v` to
 * every UPDATE WHERE, or lost-update bugs become possible on the money path.
 *
 * Idempotent POST /deals via Idempotency-Key + sha256(canonical body).
 * Key uniqueness is scoped per-client (uq_deals_client_idempotency); two
 * unrelated clients can pick the same string without colliding.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  categories,
  dealEvents,
  deals,
  disputeEvidence,
  listings,
  mediaObjects,
  outboxEvents,
  users,
} from "../db/schema.js";

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

// Spec REQ-014: agreed_price ceiling is ₴999,999.99 = 99_999_999 kopecks.
// Mirrored by chk_deals_price_cap CHECK (migration 0015).
const MAX_AGREED_PRICE_KOPECKS = 99_999_999;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function canonicalHash(body: Record<string, unknown>): string {
  const sortedKeys = Object.keys(body).sort();
  const canon: Record<string, unknown> = {};
  for (const k of sortedKeys) canon[k] = body[k];
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

async function logEvent(tx: Tx, args: {
  deal_id: string;
  actor_id: string | null;
  actor_role: "client" | "provider" | "admin" | "system";
  event_type: string;
  from_status?: string | null;
  to_status?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await tx.insert(dealEvents).values({
    deal_id: args.deal_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role,
    event_type: args.event_type,
    from_status: args.from_status ?? null,
    to_status: args.to_status ?? null,
    metadata: args.metadata ?? {},
  });
}

/* ------------------------------- CREATE ---------------------------------- */

export type CreateInput = {
  client_id: string;
  provider_id: string;
  category_id: string;
  listing_id?: string | null;
  title: string;
  description: string;
  agreed_price: number;
  deadline_at?: string | null;
  idempotency_key: string;
};

export async function createDeal(input: CreateInput): Promise<Result<{ id: string; status: string; version: number; replay: boolean }>> {
  if (!input.title || input.title.length > 200) {
    return err("validation_failed", 400, { fields: { title: "length_1_200" } });
  }
  if (!input.description || input.description.length < 1 || input.description.length > 5000) {
    return err("validation_failed", 400, { fields: { description: "length_1_5000" } });
  }
  if (input.agreed_price <= 0) {
    return err("validation_failed", 400, { fields: { agreed_price: "must_be_positive" } });
  }
  if (input.agreed_price > MAX_AGREED_PRICE_KOPECKS) {
    return err("validation_failed", 400, { fields: { agreed_price: "exceeds_max" } });
  }
  if (input.client_id === input.provider_id) {
    return err("validation_failed", 400, { fields: { provider_id: "same_as_client" } });
  }

  const bodyHash = canonicalHash({
    provider_id: input.provider_id,
    category_id: input.category_id,
    listing_id: input.listing_id ?? null,
    title: input.title,
    description: input.description,
    agreed_price: input.agreed_price,
    deadline_at: input.deadline_at ?? null,
  });

  return await db.transaction(async (tx) => {
    // Idempotency replay — scoped to (client_id, idempotency_key) per
    // migration 0015. Same string from a different client now means a
    // *different* logical key; the unique index allows the row, and we
    // never disclose another client's keys via 403.
    const existing = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.client_id, input.client_id), eq(deals.idempotency_key, input.idempotency_key)))
      .limit(1);
    if (existing.length > 0) {
      const d = existing[0]!;
      if (d.idempotency_body_hash !== bodyHash) return err("idempotency_body_mismatch", 409);
      return { ok: true as const, value: { id: d.id, status: d.status, version: d.version, replay: true } };
    }

    // Validate provider is actually a provider.
    const providerRows = await tx
      .select({
        has_provider_role: users.has_provider_role,
        status: users.status,
        kyc_status: users.kyc_status,
      })
      .from(users)
      .where(eq(users.id, input.provider_id))
      .limit(1);
    if (providerRows.length === 0) return err("provider_not_found", 404);
    if (!providerRows[0]!.has_provider_role) return err("not_a_provider", 422);
    if (providerRows[0]!.status !== "active") return err("provider_not_active", 422);
    // KYC mirror of the Module 5 listings gate (63f493f). A provider whose
    // KYC expired/never-approved shouldn't be findable for new deals, and
    // any direct create-from-id path needs the same defense.
    if (providerRows[0]!.kyc_status !== "approved") {
      return err("provider_kyc_not_approved", 422, {
        provider_kyc_status: providerRows[0]!.kyc_status,
      });
    }

    // Validate listing if supplied and matches provider + category.
    if (input.listing_id) {
      const lrows = await tx
        .select({
          provider_id: listings.provider_id,
          status: listings.status,
          category_id: listings.category_id,
        })
        .from(listings)
        .where(eq(listings.id, input.listing_id))
        .limit(1);
      if (lrows.length === 0) return err("listing_not_found", 404);
      if (lrows[0]!.provider_id !== input.provider_id) return err("listing_provider_mismatch", 422);
      if (lrows[0]!.status !== "active") return err("listing_not_active", 422);
      // Prevent denormalized category drift: deal's category must match the
      // listing it was created from. Otherwise analytics + ranking surface
      // misclassified deals indistinguishable from genuine ones.
      if (lrows[0]!.category_id !== input.category_id) {
        return err("listing_category_mismatch", 422, {
          expected_category_id: lrows[0]!.category_id,
        });
      }
    }

    // Validate category active.
    const crows = await tx
      .select({ status: categories.status })
      .from(categories)
      .where(eq(categories.id, input.category_id))
      .limit(1);
    if (crows.length === 0) return err("category_not_found", 404);
    if (crows[0]!.status !== "active") return err("category_not_active", 422);

    const inserted = await tx
      .insert(deals)
      .values({
        client_id: input.client_id,
        provider_id: input.provider_id,
        category_id: input.category_id,
        listing_id: input.listing_id ?? null,
        title: input.title,
        description: input.description,
        agreed_price: input.agreed_price,
        deadline_at: input.deadline_at ? new Date(input.deadline_at) : null,
        idempotency_key: input.idempotency_key,
        idempotency_body_hash: bodyHash,
      })
      .returning({ id: deals.id, status: deals.status, version: deals.version });
    const row = inserted[0]!;

    await logEvent(tx, {
      deal_id: row.id,
      actor_id: input.client_id,
      actor_role: "client",
      event_type: "deal.created",
      to_status: "pending",
      metadata: { agreed_price: input.agreed_price, listing_id: input.listing_id ?? null },
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "deal",
      aggregate_id: row.id,
      event_type: "deal.created",
      payload: {
        deal_id: row.id,
        client_id: input.client_id,
        provider_id: input.provider_id,
        agreed_price: input.agreed_price,
      },
    });

    return { ok: true as const, value: { id: row.id, status: row.status, version: row.version, replay: false } };
  });
}

/* ----------------------------- TRANSITIONS ------------------------------- */

// actor_role is intentionally NOT carried in TransitionArgs: each transition
// function derives the role from the deal it locks (client_id vs provider_id
// match). The route layer used to hard-code role="client" for all transitions,
// which mis-tagged deal_events rows for provider actions. See d68d5a8 sibling
// pattern in Modules 11/14.
type TransitionArgs = {
  deal_id: string;
  actor_id: string;
  version: number;
};

async function loadAndLock(tx: Tx, dealId: string) {
  const r = await tx.execute<{
    id: string;
    client_id: string;
    provider_id: string;
    status: string;
    version: number;
    cancel_requested_by_client_at: string | null;
    cancel_requested_by_provider_at: string | null;
  }>(
    dsql`SELECT id, client_id, provider_id, status, version,
                cancel_requested_by_client_at, cancel_requested_by_provider_at
           FROM deals WHERE id = ${dealId} FOR UPDATE`
  );
  return r[0] ?? null;
}

function versionConflict(d: { version: number; status: string }, expected: number): ServiceError | null {
  if (d.version !== expected) {
    return { code: "version_conflict", status: 409, details: { current_version: d.version, current_status: d.status } };
  }
  return null;
}

async function emit(tx: Tx, dealId: string, eventType: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({
    aggregate_type: "deal",
    aggregate_id: dealId,
    event_type: eventType,
    payload: { deal_id: dealId, ...payload },
  });
}

/* /accept — provider only: pending → active */
export async function acceptDeal(args: TransitionArgs): Promise<Result<{ id: string; status: string; version: number }>> {
  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    if (d.provider_id !== args.actor_id) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };
    if (d.status !== "pending") return err("status_conflict", 409, { current_version: d.version, current_status: d.status });

    await tx
      .update(deals)
      .set({
        status: "active",
        version: d.version + 1,
        // MVP: skip Payments escrow gate (TODO Module 11). escrow_status stays
        // 'not_required'; chk_held_requires_id fires if we set 'held' without
        // an escrow_hold_id. When Payments lands this becomes a /internal
        // callback that promotes pending→active and stamps held + hold_id.
      })
      .where(eq(deals.id, d.id));

    await logEvent(tx, { deal_id: d.id, actor_id: args.actor_id, actor_role: "provider", event_type: "deal.activated", from_status: "pending", to_status: "active" });
    await emit(tx, d.id, "deal.activated", { provider_id: d.provider_id, client_id: d.client_id });

    return { ok: true as const, value: { id: d.id, status: "active", version: d.version + 1 } };
  });
}

/* /reject — provider only: pending → cancelled */
export async function rejectDeal(args: TransitionArgs): Promise<Result<{ id: string; status: string; version: number }>> {
  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    if (d.provider_id !== args.actor_id) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };
    if (d.status !== "pending") return err("status_conflict", 409, { current_version: d.version, current_status: d.status });

    await tx
      .update(deals)
      .set({
        status: "cancelled",
        version: d.version + 1,
        cancellation_reason: "rejected_by_provider",
      })
      .where(eq(deals.id, d.id));

    await logEvent(tx, { deal_id: d.id, actor_id: args.actor_id, actor_role: "provider", event_type: "deal.rejected", from_status: "pending", to_status: "cancelled" });
    await emit(tx, d.id, "deal.rejected", { reason: "rejected_by_provider" });

    return { ok: true as const, value: { id: d.id, status: "cancelled", version: d.version + 1 } };
  });
}

/* /submit — provider: active → in_review */
export async function submitDeal(args: TransitionArgs): Promise<Result<{ id: string; status: string; version: number }>> {
  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    if (d.provider_id !== args.actor_id) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };
    if (d.status !== "active") return err("status_conflict", 409, { current_version: d.version, current_status: d.status });

    const now = new Date();
    const autoCompleteAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const disputeWindow = new Date(autoCompleteAt.getTime() + 24 * 3600 * 1000);

    await tx
      .update(deals)
      .set({
        status: "in_review",
        version: d.version + 1,
        review_started_at: now,
        auto_complete_after: autoCompleteAt,
        dispute_window_until: disputeWindow,
      })
      .where(eq(deals.id, d.id));

    await logEvent(tx, { deal_id: d.id, actor_id: args.actor_id, actor_role: "provider", event_type: "deal.submitted", from_status: "active", to_status: "in_review" });
    await emit(tx, d.id, "deal.submitted", { auto_complete_after: autoCompleteAt.toISOString() });

    return { ok: true as const, value: { id: d.id, status: "in_review", version: d.version + 1 } };
  });
}

/* /approve — client: in_review → completed */
export async function approveDeal(args: TransitionArgs): Promise<Result<{ id: string; status: string; version: number }>> {
  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    if (d.client_id !== args.actor_id) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };
    if (d.status !== "in_review") return err("status_conflict", 409, { current_version: d.version, current_status: d.status });

    const completedAt = new Date();
    await tx
      .update(deals)
      .set({
        status: "completed",
        version: d.version + 1,
        // Stable anchor for Module 7's 60d review window; written ONCE on
        // first 'completed' transition. See migration 0016.
        completed_at: completedAt,
        // TODO Module 11: escrow release is sweep-driven per spec REQ-015 —
        // emit deal.escrow_release_requested from the release sweep after
        // dispute_window_until elapses, NOT from /approve.
      })
      .where(eq(deals.id, d.id));

    await logEvent(tx, { deal_id: d.id, actor_id: args.actor_id, actor_role: "client", event_type: "deal.approved", from_status: "in_review", to_status: "completed" });
    await emit(tx, d.id, "deal.approved", { provider_id: d.provider_id });

    return { ok: true as const, value: { id: d.id, status: "completed", version: d.version + 1 } };
  });
}

/* /dispute — client: in_review → disputed (or completed → disputed in grace window) */
export async function disputeDeal(args: TransitionArgs & {
  reason: string;
  attachment_ids?: string[];
}): Promise<Result<{ id: string; status: string; version: number }>> {
  if (args.reason.length < 30) return err("reason_too_short", 422, { min: 30 });
  if (!args.attachment_ids || args.attachment_ids.length === 0) {
    return err("attachment_required", 422);
  }

  // SEC-005: attachment_ids must reference media uploaded by the disputing
  // party with purpose='dispute_evidence' and status='ready'. Otherwise a
  // malicious client could stuff in another user's media UUID, exposing it
  // to the admin reviewing the dispute. Validation runs outside the tx —
  // the media rows are immutable once 'ready' so no TOCTOU concern.
  const mediaRows = await db
    .select({
      id: mediaObjects.id,
      owner_user_id: mediaObjects.owner_user_id,
      purpose: mediaObjects.purpose,
      status: mediaObjects.status,
    })
    .from(mediaObjects)
    .where(inArray(mediaObjects.id, args.attachment_ids));
  const byId = new Map(mediaRows.map((m) => [m.id, m]));
  for (const aid of args.attachment_ids) {
    const m = byId.get(aid);
    if (!m) return err("attachment_not_found", 422, { media_id: aid });
    if (m.owner_user_id !== args.actor_id) {
      return err("attachment_forbidden", 422, { media_id: aid });
    }
    if (m.purpose !== "dispute_evidence") {
      return err("attachment_wrong_purpose", 422, {
        media_id: aid,
        expected: "dispute_evidence",
        got: m.purpose,
      });
    }
    if (m.status !== "ready") {
      return err("attachment_not_ready", 422, { media_id: aid, status: m.status });
    }
  }

  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    if (d.client_id !== args.actor_id) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };
    if (d.status !== "in_review" && d.status !== "completed") {
      return err("status_conflict", 409, { current_version: d.version, current_status: d.status });
    }
    // Grace window for completed → disputed: only if dispute_window_until has
    // not passed AND escrow release is not yet in flight or terminal. Spec
    // REQ-007 — once the release sweep flips escrow_status to release_requested,
    // the deal is no longer rollbackable (PSP-side capture is happening).
    if (d.status === "completed") {
      const r = await tx.execute<{
        dispute_window_until: string | null;
        escrow_status: string;
      }>(
        dsql`SELECT dispute_window_until, escrow_status FROM deals WHERE id = ${d.id}`
      );
      const dw = r[0]?.dispute_window_until ? new Date(r[0].dispute_window_until) : null;
      if (!dw || dw.getTime() < Date.now()) return err("dispute_window_closed", 409);
      const es = r[0]?.escrow_status ?? "not_required";
      const TERMINAL_OR_INFLIGHT = ["release_requested", "released", "refund_requested", "refunded"];
      if (TERMINAL_OR_INFLIGHT.includes(es)) {
        return err("escrow_already_released", 409, { escrow_status: es });
      }
    }

    const now = new Date();
    const resolveBy = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    await tx
      .update(deals)
      .set({
        status: "disputed",
        version: d.version + 1,
        dispute_opened_at: now,
        dispute_resolve_by: resolveBy,
      })
      .where(eq(deals.id, d.id));

    // REQ-003 / DSP-PAT-003 / AC-001: client evidence row inserted atomically
    // with the status transition. Spec forbids a "disputed" deal with zero
    // dispute_evidence rows. The follow-up /dispute/evidence call would be
    // redundant; /dispute/respond is provider's only entry.
    await tx.insert(disputeEvidence).values({
      deal_id: d.id,
      party_role: "client",
      uploader_user_id: args.actor_id,
      reason: "initial_dispute",
      statement: args.reason,
      attachment_ids: args.attachment_ids ?? [],
    });

    await logEvent(tx, {
      deal_id: d.id,
      actor_id: args.actor_id,
      actor_role: "client",
      event_type: "deal.disputed",
      from_status: d.status,
      to_status: "disputed",
      metadata: { reason: args.reason, attachment_ids: args.attachment_ids },
    });
    await emit(tx, d.id, "deal.disputed", { reason: args.reason, dispute_resolve_by: resolveBy.toISOString() });

    return { ok: true as const, value: { id: d.id, status: "disputed", version: d.version + 1 } };
  });
}

/* /cancel — client or provider:
 *   - pending: unilateral cancel
 *   - active: mutual cancel (both parties must request within 48h)
 */
export async function cancelDeal(args: TransitionArgs): Promise<Result<{ id: string; status: string; version: number }>> {
  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    const isClient = d.client_id === args.actor_id;
    const isProvider = d.provider_id === args.actor_id;
    if (!isClient && !isProvider) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };

    if (d.status === "pending" && isClient) {
      await tx
        .update(deals)
        .set({ status: "cancelled", version: d.version + 1, cancellation_reason: "cancelled_by_client" })
        .where(eq(deals.id, d.id));
      await logEvent(tx, { deal_id: d.id, actor_id: args.actor_id, actor_role: "client", event_type: "deal.cancelled_by_client", from_status: "pending", to_status: "cancelled" });
      await emit(tx, d.id, "deal.cancelled_by_client", {});
      return { ok: true as const, value: { id: d.id, status: "cancelled", version: d.version + 1 } };
    }

    if (d.status === "active") {
      // Prevent the requesting party from re-arming the 48h window or bumping
      // version on every retry. Only the *counterparty* may flip an active
      // cancel-request into a mutual-cancel.
      if (isClient && d.cancel_requested_by_client_at) {
        return err("cancel_already_requested", 409, { by: "client" });
      }
      if (isProvider && d.cancel_requested_by_provider_at) {
        return err("cancel_already_requested", 409, { by: "provider" });
      }

      const now = new Date();
      const set: Record<string, unknown> = { version: d.version + 1 };
      if (isClient) set.cancel_requested_by_client_at = now;
      else set.cancel_requested_by_provider_at = now;

      const bothReqd =
        (isClient && d.cancel_requested_by_provider_at) ||
        (isProvider && d.cancel_requested_by_client_at);

      if (bothReqd) {
        set.status = "cancelled";
        set.cancellation_reason = "mutual";
      }

      await tx.update(deals).set(set).where(eq(deals.id, d.id));
      if (bothReqd) {
        await logEvent(tx, {
          deal_id: d.id,
          actor_id: args.actor_id,
          actor_role: isClient ? "client" : "provider",
          event_type: "deal.cancelled_mutual",
          from_status: "active",
          to_status: "cancelled",
        });
        await emit(tx, d.id, "deal.cancelled_mutual", {});
        return { ok: true as const, value: { id: d.id, status: "cancelled", version: d.version + 1 } };
      } else {
        await logEvent(tx, {
          deal_id: d.id,
          actor_id: args.actor_id,
          actor_role: isClient ? "client" : "provider",
          event_type: "deal.cancel_requested",
          metadata: { by: isClient ? "client" : "provider" },
        });
        return { ok: true as const, value: { id: d.id, status: "active", version: d.version + 1 } };
      }
    }

    return err("status_conflict", 409, { current_version: d.version, current_status: d.status });
  });
}

/* ------------------------------- READ ------------------------------------ */

/** FE Deal shape (web/src/lib/deals.ts:22). */
type DealFE = {
  id: string;
  listing_id: string;
  client_id: string;
  provider_id: string;
  status: string;
  scope: string;
  urgency: "today" | "tomorrow" | "week" | "later";
  deadline_at: string | null;
  address: string;
  phone: string;
  attachment_ids: string[];
  budget_kopecks: number;
  fee_kopecks: number;
  total_held_kopecks: number;
  hold_id: string;
  created_at: string;
  listing_title_snapshot: string;
  cancel_requested_by_client_at: string | null;
  cancel_requested_by_provider_at: string | null;
  cancel_request_reason: string | null;
  dispute_evidence_client: { reason: string; statement: string; attachment_ids: string[]; submitted_at: string } | null;
  dispute_evidence_provider: { reason: string; statement: string; attachment_ids: string[]; submitted_at: string } | null;
  dispute_evidence_visibility: "open" | "redacted" | "revealed";
  dispute_resolution: { verdict: "refund_client" | "release_to_provider"; resolver_admin_id: string; reason: string; resolved_at: string } | null;
  client: { id: string; display_name: string; avatar_url?: string; kyc_verified: boolean };
  provider: { id: string; display_name: string; avatar_url?: string; kyc_verified: boolean };
  version: number;
};

function urgencyFromDeadline(deadline: Date | string | null): DealFE["urgency"] {
  if (!deadline) return "later";
  const d = typeof deadline === "string" ? new Date(deadline) : deadline;
  const hours = (d.getTime() - Date.now()) / (1000 * 3600);
  if (hours <= 24) return "today";
  if (hours <= 48) return "tomorrow";
  if (hours <= 168) return "week";
  return "later";
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? new Date(v).toISOString() : v.toISOString();
}

async function projectDealFE(dealId: string, viewerId: string): Promise<DealFE | null | "forbidden"> {
  const rows = await db.execute<{
    id: string;
    client_id: string;
    provider_id: string;
    listing_id: string | null;
    status: string;
    title: string;
    agreed_price: number;
    deadline_at: Date | string | null;
    escrow_hold_id: string | null;
    cancel_requested_by_client_at: Date | string | null;
    cancel_requested_by_provider_at: Date | string | null;
    cancellation_reason: string | null;
    resolution_outcome: string | null;
    resolution_note: string | null;
    resolved_by_admin_id: string | null;
    resolved_at: Date | string | null;
    version: number;
    created_at: Date | string;
    listing_title_snapshot: string | null;
    c_name: string | null;
    c_avatar: string | null;
    c_kyc_at: Date | string | null;
    p_name: string | null;
    p_avatar: string | null;
    p_kyc_at: Date | string | null;
  }>(
    dsql`SELECT d.id, d.client_id, d.provider_id, d.listing_id, d.status,
                d.title, d.agreed_price, d.deadline_at,
                d.escrow_hold_id,
                d.cancel_requested_by_client_at, d.cancel_requested_by_provider_at,
                d.cancellation_reason,
                d.resolution_outcome, d.resolution_note, d.resolved_by_admin_id, d.resolved_at,
                d.version, d.created_at,
                l.title AS listing_title_snapshot,
                cu.display_name AS c_name, cu.avatar_url AS c_avatar, cu.kyc_approved_at AS c_kyc_at,
                pu.display_name AS p_name, pu.avatar_url AS p_avatar, pu.kyc_approved_at AS p_kyc_at
           FROM deals d
           LEFT JOIN listings l ON l.id = d.listing_id
           LEFT JOIN users cu ON cu.id = d.client_id
           LEFT JOIN users pu ON pu.id = d.provider_id
          WHERE d.id = ${dealId}
          LIMIT 1`
  );
  const r = rows[0];
  if (!r) return null;
  if (r.client_id !== viewerId && r.provider_id !== viewerId) return "forbidden";

  const evidenceRows = await db.execute<{
    party_role: "client" | "provider";
    reason: string | null;
    statement: string | null;
    attachment_ids: unknown;
    submitted_at: Date | string;
  }>(
    dsql`SELECT party_role, reason, statement, attachment_ids, submitted_at
           FROM dispute_evidence WHERE deal_id = ${dealId}`
  );
  const evClient = evidenceRows.find((e) => e.party_role === "client");
  const evProvider = evidenceRows.find((e) => e.party_role === "provider");
  const mkEvidence = (e: typeof evClient) =>
    e
      ? {
          reason: e.reason ?? "other",
          statement: e.statement ?? "",
          attachment_ids: Array.isArray(e.attachment_ids) ? (e.attachment_ids as string[]) : [],
          submitted_at: typeof e.submitted_at === "string" ? new Date(e.submitted_at).toISOString() : e.submitted_at.toISOString(),
        }
      : null;

  // Resolution mapping: 'refund_to_client' → 'refund_client'; everything else
  // (release_to_provider, split) → 'release_to_provider' (closest FE enum).
  const resolution: DealFE["dispute_resolution"] = r.resolution_outcome
    ? {
        verdict: r.resolution_outcome === "refund_to_client" ? "refund_client" : "release_to_provider",
        resolver_admin_id: r.resolved_by_admin_id ?? "",
        reason: r.resolution_note ?? "",
        resolved_at: isoOrNull(r.resolved_at) ?? "",
      }
    : null;

  return {
    id: r.id,
    listing_id: r.listing_id ?? "",
    client_id: r.client_id,
    provider_id: r.provider_id,
    status: r.status,
    scope: r.title,
    urgency: urgencyFromDeadline(r.deadline_at),
    deadline_at: isoOrNull(r.deadline_at),
    address: "",
    phone: "",
    attachment_ids: [],
    budget_kopecks: r.agreed_price,
    fee_kopecks: 0,
    total_held_kopecks: r.agreed_price,
    hold_id: r.escrow_hold_id ?? "",
    created_at: isoOrNull(r.created_at) ?? new Date().toISOString(),
    listing_title_snapshot: r.listing_title_snapshot ?? r.title,
    cancel_requested_by_client_at: isoOrNull(r.cancel_requested_by_client_at),
    cancel_requested_by_provider_at: isoOrNull(r.cancel_requested_by_provider_at),
    cancel_request_reason: r.cancellation_reason,
    dispute_evidence_client: mkEvidence(evClient),
    dispute_evidence_provider: mkEvidence(evProvider),
    dispute_evidence_visibility: r.status === "disputed" ? "open" : "redacted",
    dispute_resolution: resolution,
    client: {
      id: r.client_id,
      display_name: r.c_name ?? "",
      avatar_url: r.c_avatar ?? undefined,
      kyc_verified: r.c_kyc_at != null,
    },
    provider: {
      id: r.provider_id,
      display_name: r.p_name ?? "",
      avatar_url: r.p_avatar ?? undefined,
      kyc_verified: r.p_kyc_at != null,
    },
    version: r.version,
  };
}

export async function getDeal(viewerId: string, dealId: string) {
  return projectDealFE(dealId, viewerId);
}

/** Cursor: base64url JSON `{t: ISO string, i: deal-id}` for keyset on (created_at DESC, id DESC). */
function encodeListCursor(createdAt: Date | string, id: string): string {
  const t = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  return Buffer.from(JSON.stringify({ t, i: id })).toString("base64url");
}
function decodeListCursor(s: string): { t: string; i: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<{ t: string; i: string }>;
    if (!parsed.t || !parsed.i) return null;
    if (Number.isNaN(new Date(parsed.t).getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(parsed.i)) return null;
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
}

export async function listMine(
  viewerId: string,
  opts: { status?: string; limit: number; cursor?: string }
): Promise<{ items: unknown[]; next_cursor: string | null } | { error: "cursor_invalid" }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [or(eq(deals.client_id, viewerId), eq(deals.provider_id, viewerId))!];
  if (opts.status) where.push(eq(deals.status, opts.status as "active"));
  if (opts.cursor) {
    const cur = decodeListCursor(opts.cursor);
    if (!cur) return { error: "cursor_invalid" };
    where.push(
      dsql`(${deals.created_at}, ${deals.id}) < (${new Date(cur.t)}, ${cur.i})`
    );
  }
  const rows = await db
    .select()
    .from(deals)
    .where(and(...where))
    .orderBy(desc(deals.created_at), desc(deals.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor =
    hasMore && items.length > 0
      ? encodeListCursor(items[items.length - 1]!.created_at, items[items.length - 1]!.id)
      : null;
  return { items, next_cursor };
}

export async function listEvents(viewerId: string, dealId: string) {
  const d = await getDeal(viewerId, dealId);
  if (!d) return null;
  if (d === "forbidden") return "forbidden" as const;
  const rows = await db
    .select()
    .from(dealEvents)
    .where(eq(dealEvents.deal_id, dealId))
    .orderBy(desc(dealEvents.created_at))
    .limit(200);
  return { items: rows };
}
