/**
 * Module 11 mock — provider-side wallet + append-only ledger.
 *
 * Real backend keeps 5 system accounts (escrow_pending, fee_revenue,
 * provider_available, provider_pending_payout, chargeback_liability) plus
 * per-user balances, with a DEFERRED SUM(debit)=SUM(credit) trigger across
 * the ledger. The mock is a flat append-only list of LedgerEntry rows that
 * we filter for provider-facing reads — sufficient for FE testing of the
 * wallet card + transactions list. Reconciliation, ASYNC capture, PSP
 * sequencing (PAY-PAT-003) are out of scope here.
 *
 * Lifecycle hooks called from _mock/deals.ts:
 *   onDealAccepted   — hold lands on provider.held (mirror of PSP pre-auth)
 *   onDealCompleted  — capture: held -> available - fee, +fee revenue
 *   onDealRefunded   — refund: held -> 0 (no provider movement)
 */

import { findListing } from "./listings";

export type LedgerKind =
  | "hold"           // active: client deposit reserved against this provider
  | "capture"        // completed: net moves to provider available
  | "fee"            // platform service fee (5% by default)
  | "refund"         // cancellation: hold drops, no provider net
  | "payout_request" // provider requested withdrawal
  | "payout_paid";   // PSP confirmed payout

export type LedgerEntry = {
  id: string;
  user_id: string;
  /** Sign by lens: 'held'|'available'|'pending_payout' bucket and +/-. */
  bucket: "held" | "available" | "pending_payout";
  amount_kopecks: number; // signed
  kind: LedgerKind;
  /** ISO timestamp. */
  created_at: string;
  /** Optional deal/listing/payout linkage for the operations list. */
  deal_id?: string;
  payout_id?: string;
  /** Human label rendered by the dashboard (Ukrainian). */
  memo: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_LEDGER__: LedgerEntry[] | undefined;
}

function ledger(): LedgerEntry[] {
  if (!globalThis.__ROBOTUN_LEDGER__) globalThis.__ROBOTUN_LEDGER__ = [];
  return globalThis.__ROBOTUN_LEDGER__;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function post(entry: Omit<LedgerEntry, "id" | "created_at">): LedgerEntry {
  const row: LedgerEntry = {
    ...entry,
    id: uuid(),
    created_at: new Date().toISOString(),
  };
  ledger().push(row);
  return row;
}

export function balanceFor(userId: string): {
  available_kopecks: number;
  held_kopecks: number;
  pending_payout_kopecks: number;
} {
  let available = 0;
  let held = 0;
  let pending = 0;
  for (const e of ledger()) {
    if (e.user_id !== userId) continue;
    if (e.bucket === "available") available += e.amount_kopecks;
    else if (e.bucket === "held") held += e.amount_kopecks;
    else if (e.bucket === "pending_payout") pending += e.amount_kopecks;
  }
  return {
    available_kopecks: Math.max(0, available),
    held_kopecks: Math.max(0, held),
    pending_payout_kopecks: Math.max(0, pending),
  };
}

export function transactionsFor(
  userId: string,
  opts: { limit?: number; cursor?: string | null } = {}
): { items: LedgerEntry[]; next_cursor: string | null; total: number } {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const own = ledger()
    .filter((e) => e.user_id === userId)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  let start = 0;
  if (opts.cursor) {
    try {
      const n = Number.parseInt(
        Buffer.from(opts.cursor, "base64url").toString("utf8"),
        10
      );
      if (Number.isFinite(n) && n > 0 && n < own.length) start = n;
    } catch {
      /* bad cursor */
    }
  }
  const slice = own.slice(start, start + limit);
  const nextIdx = start + limit;
  return {
    items: slice,
    next_cursor:
      nextIdx < own.length
        ? Buffer.from(String(nextIdx), "utf8").toString("base64url")
        : null,
    total: own.length,
  };
}

/* =====================================================================
   Deal lifecycle hooks. Module 11 §4 ledger entry shape is mocked.
   ===================================================================== */

const FEE_BPS = 500; // 5% — matches PLATFORM_FEE_BPS in _mock/deals.ts

function feeFor(budget: number): number {
  return Math.round((budget * FEE_BPS) / 10_000);
}
function netToProvider(budget: number): number {
  return budget - feeFor(budget);
}

function listingTitleSnap(deal: {
  listing_id: string;
  listing_title_snapshot: string;
}): string {
  return (
    deal.listing_title_snapshot ||
    findListing(deal.listing_id)?.title ||
    "Послуга"
  );
}

export const paymentHooks = {
  /** provider: held += net (capture target). client side is PSP pre-auth — not modelled. */
  onDealAccepted(deal: {
    id: string;
    provider_id: string;
    budget_kopecks: number;
    listing_id: string;
    listing_title_snapshot: string;
  }) {
    post({
      user_id: deal.provider_id,
      bucket: "held",
      amount_kopecks: netToProvider(deal.budget_kopecks),
      kind: "hold",
      deal_id: deal.id,
      memo: `Холд по угоді ${deal.id.slice(0, 8)} · ${listingTitleSnap(deal)}`,
    });
  },
  /** provider: held -= net, available += net, fee revenue counted (platform-side, not user-visible). */
  onDealCompleted(deal: {
    id: string;
    provider_id: string;
    budget_kopecks: number;
    listing_id: string;
    listing_title_snapshot: string;
  }) {
    const net = netToProvider(deal.budget_kopecks);
    post({
      user_id: deal.provider_id,
      bucket: "held",
      amount_kopecks: -net,
      kind: "capture",
      deal_id: deal.id,
      memo: `Зняття холду по ${deal.id.slice(0, 8)}`,
    });
    post({
      user_id: deal.provider_id,
      bucket: "available",
      amount_kopecks: net,
      kind: "capture",
      deal_id: deal.id,
      memo: `Угода ${deal.id.slice(0, 8)} завершена · ${listingTitleSnap(deal)}`,
    });
  },
  /** Cancelled/rejected from non-pending: drop the hold; no provider net. */
  onDealRefunded(deal: {
    id: string;
    provider_id: string;
    budget_kopecks: number;
    listing_id: string;
    listing_title_snapshot: string;
    /** Was there a hold to release? (transition from active|in_review|disputed). */
    hadHold: boolean;
  }) {
    if (!deal.hadHold) return;
    const net = netToProvider(deal.budget_kopecks);
    post({
      user_id: deal.provider_id,
      bucket: "held",
      amount_kopecks: -net,
      kind: "refund",
      deal_id: deal.id,
      memo: `Повернення коштів клієнту · ${deal.id.slice(0, 8)}`,
    });
  },
};
