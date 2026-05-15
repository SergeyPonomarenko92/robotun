/**
 * Module 14 — Disputes (MVP cut).
 *
 * Builds on Module 3 /deals/:id/dispute (which transitions deal to
 * disputed). This module adds:
 *  - dispute_evidence per party (client + provider statements)
 *  - admin /resolve endpoint
 *  - GET evidence (admin + participants)
 *
 * Out of scope: 21-day cap, dispute_response_due_reminder cron, evidence
 * media binding via Module 6 (attachment_ids stored as opaque JSON array),
 * 3-day counterparty-response window enforcement.
 */
import { and, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { deals, dealEvents, disputeEvidence, outboxEvents, userRoles } from "../db/schema.js";

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

function pgCode(e: unknown): string | undefined {
  const o = e as { code?: string; cause?: { code?: string } };
  return o?.code ?? o?.cause?.code;
}

export async function recordEvidence(args: {
  deal_id: string;
  user_id: string;
  party_role: "client" | "provider";
  reason: string;
  statement?: string | null;
  attachment_ids?: string[];
}): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const dr = await tx.select().from(deals).where(eq(deals.id, args.deal_id)).limit(1);
    if (dr.length === 0) return err("deal_not_found", 404);
    const d = dr[0]!;
    const expectedParty = args.party_role === "client" ? d.client_id : d.provider_id;
    if (expectedParty !== args.user_id) return err("forbidden", 403);
    if (d.status !== "disputed") return err("deal_not_disputed", 409, { current_status: d.status });
    if (!args.statement) return err("validation_failed", 400, { fields: { statement: "required" } });
    if (args.statement.length < 30 || args.statement.length > 4000) {
      return err("validation_failed", 400, { fields: { statement: "length_30_4000" } });
    }

    const inserted = await tx
      .insert(disputeEvidence)
      .values({
        deal_id: args.deal_id,
        party_role: args.party_role,
        uploader_user_id: args.user_id,
        reason: args.reason,
        statement: args.statement ?? null,
        attachment_ids: args.attachment_ids ?? [],
      })
      .returning({ id: disputeEvidence.id });
    const id = inserted[0]!.id;

    await tx.insert(outboxEvents).values({
      aggregate_type: "deal",
      aggregate_id: args.deal_id,
      event_type: args.party_role === "client" ? "dispute.evidence_submitted" : "dispute.response_submitted",
      payload: { deal_id: args.deal_id, evidence_id: id, party_role: args.party_role },
    });

    return { ok: true as const, value: { id } };
  }).catch((e) => {
    if (pgCode(e) === "23505") return err("evidence_already_submitted", 409);
    throw e;
  });
}

export async function listEvidence(viewerId: string, dealId: string) {
  const dr = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (dr.length === 0) return null;
  const d = dr[0]!;
  // Allow admin if role admin; participants always.
  let isAdmin = false;
  if (d.client_id !== viewerId && d.provider_id !== viewerId) {
    const r = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, viewerId));
    isAdmin = r.some((x) => x.role === "admin" || x.role === "moderator");
    if (!isAdmin) return "forbidden" as const;
  }
  const rows = await db
    .select()
    .from(disputeEvidence)
    .where(eq(disputeEvidence.deal_id, dealId));
  return { items: rows };
}

/* -------------------------- admin: resolve -------------------------- */

export async function resolveDispute(args: {
  deal_id: string;
  admin_id: string;
  outcome: "release_to_provider" | "refund_to_client" | "split";
  release_amount_kopecks?: number | null;
  note?: string | null;
}): Promise<Result<{ id: string; status: string; version: number }>> {
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{
      id: string;
      status: string;
      agreed_price: number;
      provider_id: string;
      client_id: string;
      version: number;
    }>(
      dsql`SELECT id, status, agreed_price, provider_id, client_id, version
             FROM deals WHERE id = ${args.deal_id} FOR UPDATE`
    );
    if (r.length === 0) return err("deal_not_found", 404);
    const d = r[0]!;
    if (d.status !== "disputed") return err("invalid_state", 409, { current_status: d.status });

    let releaseAmt = args.release_amount_kopecks ?? null;
    if (args.outcome === "release_to_provider") releaseAmt = d.agreed_price;
    else if (args.outcome === "refund_to_client") releaseAmt = 0;
    else if (args.outcome === "split") {
      if (releaseAmt == null || releaseAmt < 0 || releaseAmt > d.agreed_price) {
        return err("validation_failed", 400, { fields: { release_amount_kopecks: "out_of_range" } });
      }
    }

    const nextStatus = args.outcome === "refund_to_client" ? "cancelled" : "completed";
    const now = new Date();
    await tx
      .update(deals)
      .set({
        status: nextStatus,
        version: d.version + 1,
        resolution_outcome: args.outcome,
        resolution_release_amount: releaseAmt,
        resolution_note: args.note ?? null,
        resolved_by_admin_id: args.admin_id,
        resolved_at: now,
        // Stable 'completed' anchor for Module 7 review window — admin
        // resolution paths must populate it too, not just /approve.
        ...(nextStatus === "completed" ? { completed_at: now } : {}),
        ...(args.outcome === "refund_to_client" ? { cancellation_reason: "dispute_unresolved" } : {}),
      })
      .where(eq(deals.id, args.deal_id));

    await tx.insert(dealEvents).values({
      deal_id: args.deal_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "deal.dispute_resolved",
      from_status: "disputed",
      to_status: nextStatus,
      metadata: { outcome: args.outcome, release_amount_kopecks: releaseAmt, note: args.note ?? null },
    });

    await tx.insert(outboxEvents).values([
      {
        aggregate_type: "deal",
        aggregate_id: args.deal_id,
        event_type: "deal.dispute_resolved",
        payload: { deal_id: args.deal_id, outcome: args.outcome, release_amount_kopecks: releaseAmt },
      },
      {
        aggregate_type: "deal",
        aggregate_id: args.deal_id,
        event_type:
          args.outcome === "refund_to_client" ? "deal.escrow_refund_requested" : "deal.escrow_release_requested",
        payload: { deal_id: args.deal_id, amount_kopecks: releaseAmt },
      },
    ]);

    return { ok: true as const, value: { id: args.deal_id, status: nextStatus, version: d.version + 1 } };
  });
}
