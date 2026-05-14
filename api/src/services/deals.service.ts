/**
 * Module 3 — Deal workflow service (MVP cut).
 *
 * State machine pending → active → in_review → completed|disputed|cancelled.
 * /accept transitions pending→active synchronously (TODO Module 11 will
 * gate via /internal/deals/{id}/escrow-held callback). All transitions
 * use optimistic version concurrency control.
 *
 * Idempotent POST /deals via Idempotency-Key + sha256(canonical body).
 * Replay with same key+hash returns existing row 200; mismatch → 409.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, or, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  categories,
  dealEvents,
  deals,
  disputeEvidence,
  listings,
  outboxEvents,
  users,
} from "../db/schema.js";

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

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
    // Idempotency replay
    const existing = await tx
      .select()
      .from(deals)
      .where(eq(deals.idempotency_key, input.idempotency_key))
      .limit(1);
    if (existing.length > 0) {
      const d = existing[0]!;
      if (d.client_id !== input.client_id) return err("forbidden", 403);
      if (d.idempotency_body_hash !== bodyHash) return err("idempotency_body_mismatch", 409);
      return { ok: true as const, value: { id: d.id, status: d.status, version: d.version, replay: true } };
    }

    // Validate provider is actually a provider.
    const providerRows = await tx
      .select({ has_provider_role: users.has_provider_role, status: users.status })
      .from(users)
      .where(eq(users.id, input.provider_id))
      .limit(1);
    if (providerRows.length === 0) return err("provider_not_found", 404);
    if (!providerRows[0]!.has_provider_role) return err("not_a_provider", 422);
    if (providerRows[0]!.status !== "active") return err("provider_not_active", 422);

    // Validate listing if supplied and matches provider.
    if (input.listing_id) {
      const lrows = await tx
        .select({ provider_id: listings.provider_id, status: listings.status })
        .from(listings)
        .where(eq(listings.id, input.listing_id))
        .limit(1);
      if (lrows.length === 0) return err("listing_not_found", 404);
      if (lrows[0]!.provider_id !== input.provider_id) return err("listing_provider_mismatch", 422);
      if (lrows[0]!.status !== "active") return err("listing_not_active", 422);
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

type TransitionArgs = {
  deal_id: string;
  actor_id: string;
  actor_role: "client" | "provider" | "admin";
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

    await tx
      .update(deals)
      .set({
        status: "completed",
        version: d.version + 1,
        // TODO Module 11: emit deal.escrow_release_requested + flip escrow_status.
      })
      .where(eq(deals.id, d.id));

    await logEvent(tx, { deal_id: d.id, actor_id: args.actor_id, actor_role: "client", event_type: "deal.approved", from_status: "in_review", to_status: "completed" });
    await emit(tx, d.id, "deal.approved", { provider_id: d.provider_id });
    await emit(tx, d.id, "deal.escrow_release_requested", { provider_id: d.provider_id });

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

  return await db.transaction(async (tx) => {
    const d = await loadAndLock(tx, args.deal_id);
    if (!d) return err("deal_not_found", 404);
    if (d.client_id !== args.actor_id) return err("forbidden", 403);
    const v = versionConflict(d, args.version);
    if (v) return { ok: false as const, error: v };
    if (d.status !== "in_review" && d.status !== "completed") {
      return err("status_conflict", 409, { current_version: d.version, current_status: d.status });
    }
    // Grace window for completed → disputed: only if dispute_window_until has not passed.
    if (d.status === "completed") {
      const r = await tx.execute<{ dispute_window_until: string | null; escrow_released_at: string | null }>(
        dsql`SELECT dispute_window_until, escrow_released_at FROM deals WHERE id = ${d.id}`
      );
      const dw = r[0]?.dispute_window_until ? new Date(r[0].dispute_window_until) : null;
      if (!dw || dw.getTime() < Date.now()) return err("dispute_window_closed", 409);
      if (r[0]?.escrow_released_at) return err("escrow_already_released", 409);
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

export async function getDeal(viewerId: string, dealId: string) {
  const rows = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (rows.length === 0) return null;
  const d = rows[0]!;
  if (d.client_id !== viewerId && d.provider_id !== viewerId) {
    // Admin viewer would need role check — defer to caller.
    return "forbidden" as const;
  }
  return d;
}

export async function listMine(viewerId: string, opts: { status?: string; limit: number }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [or(eq(deals.client_id, viewerId), eq(deals.provider_id, viewerId))!];
  if (opts.status) where.push(eq(deals.status, opts.status as "active"));
  const rows = await db
    .select()
    .from(deals)
    .where(and(...where))
    .orderBy(desc(deals.created_at))
    .limit(limit);
  return { items: rows };
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
