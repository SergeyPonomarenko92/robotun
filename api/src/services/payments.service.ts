/**
 * Module 11 — Payments service (MVP cut).
 *
 * Per-deal payment state is derived from deals.status (no payments table
 * in MVP). Real backend with PSP integration would materialize a
 * `payments` row + ledger entries. Provider wallet computed at read time.
 */
import { and, desc, eq, isNotNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { deals, outboxEvents, payouts, users } from "../db/schema.js";

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

export type DealPayment = {
  deal_id: string;
  amount_kopecks: number;
  currency: string;
  state: "none" | "held" | "released" | "refunded";
  held_at: string | null;
  released_at: string | null;
  refunded_at: string | null;
};

/**
 * Reasons whose deals never reached active+ status → escrow was never held.
 * Distinguished from "actually refunded" (mutual cancel from active, dispute
 * resolved with refund_to_client) where funds had been held.
 */
const NEVER_HELD_REASONS = new Set([
  "cancelled_by_client",
  "rejected_by_provider",
  "escrow_timeout",
  "escrow_hold_expired",
  "expired_pending",
]);

function paymentStateFromDeal(d: {
  status: string;
  cancellation_reason: string | null;
  cancel_requested_by_client_at: Date | null;
  cancel_requested_by_provider_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): { state: DealPayment["state"]; released_at: Date | null; refunded_at: Date | null; held_at: Date | null } {
  if (d.status === "pending") return { state: "none", released_at: null, refunded_at: null, held_at: null };
  if (d.status === "completed") return { state: "released", released_at: d.updated_at, refunded_at: null, held_at: d.created_at };
  if (d.status === "cancelled") {
    if (d.cancellation_reason && NEVER_HELD_REASONS.has(d.cancellation_reason)) {
      return { state: "none", released_at: null, refunded_at: null, held_at: null };
    }
    return { state: "refunded", released_at: null, refunded_at: d.updated_at, held_at: d.created_at };
  }
  return { state: "held", released_at: null, refunded_at: null, held_at: d.created_at };
}

export async function getDealPayment(viewerId: string, dealId: string): Promise<DealPayment | "forbidden" | null> {
  const rows = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (rows.length === 0) return null;
  const d = rows[0]!;
  if (d.client_id !== viewerId && d.provider_id !== viewerId) return "forbidden";
  const st = paymentStateFromDeal(d);
  return {
    deal_id: d.id,
    amount_kopecks: d.agreed_price,
    currency: d.currency,
    state: st.state,
    held_at: st.held_at?.toISOString() ?? null,
    released_at: st.released_at?.toISOString() ?? null,
    refunded_at: st.refunded_at?.toISOString() ?? null,
  };
}

/* ------------------------------- wallet --------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

async function computeWallet(executor: Tx, providerId: string) {
  const earned = await executor.execute<{ s: number | null }>(
    dsql`SELECT COALESCE(SUM(agreed_price), 0)::bigint AS s FROM deals
          WHERE provider_id = ${providerId} AND status = 'completed'`
  );
  const paidOut = await executor.execute<{ s: number | null }>(
    dsql`SELECT COALESCE(SUM(amount_kopecks), 0)::bigint AS s FROM payouts
          WHERE provider_id = ${providerId} AND status IN ('completed','processing','requested')`
  );
  // NOTE: Number() coerces bigint→number; safe under 2^53 kopecks (~90T UAH).
  // Switch to BigInt + string serialization once aggregates approach that.
  const earnedNum = Number(earned[0]?.s ?? 0);
  const paidNum = Number(paidOut[0]?.s ?? 0);
  return {
    earned_kopecks: earnedNum,
    paid_out_kopecks: paidNum,
    available_kopecks: Math.max(earnedNum - paidNum, 0),
    currency: "UAH",
  };
}

export async function getWallet(providerId: string) {
  return computeWallet(db, providerId);
}

/* ------------------------------ payouts --------------------------------- */

export async function requestPayout(args: {
  provider_id: string;
  amount_kopecks: number;
  target_last4?: string;
}): Promise<Result<{ id: string; status: string }>> {
  if (args.amount_kopecks <= 0) return err("validation_failed", 400, { fields: { amount_kopecks: "must_be_positive" } });

  return await db.transaction(async (tx) => {
    // FOR UPDATE on the user row serializes concurrent payout requests for
    // the same provider. Without this lock, two simultaneous calls can both
    // pass the wallet check at available=X and both insert payouts summing
    // to 2X → silent overdraft.
    const u = await tx.execute<{ payout_enabled: boolean; kyc_status: string; status: string }>(
      dsql`SELECT payout_enabled, kyc_status, status
             FROM users WHERE id = ${args.provider_id} FOR UPDATE`
    );
    if (u.length === 0) return err("user_not_found", 404);
    if (u[0]!.status !== "active") return err("account_suspended", 403);
    if (!u[0]!.payout_enabled) return err("payout_disabled", 403, { kyc_status: u[0]!.kyc_status });

    const wallet = await computeWallet(tx, args.provider_id);
    if (args.amount_kopecks > wallet.available_kopecks) {
      return err("insufficient_funds", 422, { available_kopecks: wallet.available_kopecks });
    }

    const inserted = await tx
      .insert(payouts)
      .values({
        provider_id: args.provider_id,
        amount_kopecks: args.amount_kopecks,
        target_last4: args.target_last4 ?? null,
      })
      .returning({ id: payouts.id, status: payouts.status });
    const row = inserted[0]!;

    await tx.insert(outboxEvents).values({
      aggregate_type: "payout",
      aggregate_id: row.id,
      event_type: "payout.requested",
      payload: { payout_id: row.id, provider_id: args.provider_id, amount_kopecks: args.amount_kopecks },
    });

    return { ok: true as const, value: { id: row.id, status: row.status } };
  });
}

export async function listPayouts(providerId: string, opts: { limit: number }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.provider_id, providerId))
    .orderBy(desc(payouts.requested_at))
    .limit(limit);
  return { items: rows };
}

/* -------------------------- admin payout actions ------------------------- */

export async function markPayoutCompleted(args: { payout_id: string; admin_id: string }): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    // Conditional UPDATE collapses SELECT+UPDATE TOCTOU into one statement —
    // two admins racing won't both emit payout.completed.
    const now = new Date();
    const upd = await tx.execute<{ id: string; provider_id: string; amount_kopecks: number }>(
      dsql`UPDATE payouts
              SET status = 'completed',
                  processed_at = COALESCE(processed_at, ${now}),
                  completed_at = ${now}
            WHERE id = ${args.payout_id}
              AND status IN ('requested','processing')
            RETURNING id, provider_id, amount_kopecks`
    );
    if (upd.length === 0) {
      const cur = await tx.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, args.payout_id)).limit(1);
      if (cur.length === 0) return err("not_found", 404);
      return err("invalid_state", 409, { current_status: cur[0]!.status });
    }
    const p = upd[0]!;
    await tx.insert(outboxEvents).values({
      aggregate_type: "payout",
      aggregate_id: args.payout_id,
      event_type: "payout.completed",
      payload: { payout_id: args.payout_id, provider_id: p.provider_id, amount_kopecks: p.amount_kopecks },
    });
    return { ok: true as const, value: { id: args.payout_id } };
  });
}

export async function markPayoutFailed(args: { payout_id: string; admin_id: string; reason: string }): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const upd = await tx.execute<{ id: string }>(
      dsql`UPDATE payouts
              SET status = 'failed',
                  failure_reason = ${args.reason},
                  processed_at = ${new Date()}
            WHERE id = ${args.payout_id}
              AND status IN ('requested','processing')
            RETURNING id`
    );
    if (upd.length === 0) {
      const cur = await tx.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, args.payout_id)).limit(1);
      if (cur.length === 0) return err("not_found", 404);
      return err("invalid_state", 409, { current_status: cur[0]!.status });
    }
    await tx.insert(outboxEvents).values({
      aggregate_type: "payout",
      aggregate_id: args.payout_id,
      event_type: "payout.failed",
      payload: { payout_id: args.payout_id, reason: args.reason },
    });
    return { ok: true as const, value: { id: args.payout_id } };
  });
}
