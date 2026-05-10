/**
 * Module 3 mock — Deal lifecycle state in-memory.
 *
 * State machine (CLAUDE.md):
 *   pending → active → in_review → completed | disputed | cancelled
 *
 * Client initiates (status='pending'), Provider must confirm to advance to
 * 'active'. KYC required for payout (Module 4), NOT for deal creation.
 */

export type DealStatus =
  | "pending"
  | "active"
  | "in_review"
  | "completed"
  | "disputed"
  | "cancelled";

export type Urgency = "today" | "tomorrow" | "week" | "later";

export type MockDeal = {
  id: string;
  listing_id: string;
  client_id: string;
  provider_id: string;
  status: DealStatus;

  /** Free-text scope from the brief, 40..1500 chars. */
  scope: string;
  urgency: Urgency;
  /** ISO або null. */
  deadline_at: string | null;
  address: string;
  phone: string;
  attachment_ids: string[];

  /** Money — kopecks, never floats. */
  budget_kopecks: number;
  fee_kopecks: number;
  total_held_kopecks: number;

  /** Mock escrow hold reference (Module 11 payments owns this in real impl). */
  hold_id: string;

  created_at: string;
  /** Денормалізований заголовок listing на момент створення — для
   *  client-side card preview без додаткового JOIN. */
  listing_title_snapshot: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_DEALS__: Map<string, MockDeal> | undefined;
}
function db() {
  if (!globalThis.__ROBOTUN_DEALS__) {
    globalThis.__ROBOTUN_DEALS__ = new Map<string, MockDeal>();
  }
  return globalThis.__ROBOTUN_DEALS__;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export const PLATFORM_FEE_BPS = 500; // 5.00% in basis points (Module 11 mock)

export const dealsStore = {
  insert(input: Omit<MockDeal, "id" | "status" | "created_at" | "fee_kopecks" | "total_held_kopecks" | "hold_id">): MockDeal {
    const fee = Math.round(input.budget_kopecks * PLATFORM_FEE_BPS / 10_000);
    const deal: MockDeal = {
      ...input,
      id: uuid(),
      status: "pending",
      created_at: new Date().toISOString(),
      fee_kopecks: fee,
      total_held_kopecks: input.budget_kopecks + fee,
      hold_id: "hold_" + uuid().replace(/-/g, "").slice(0, 16),
    };
    db().set(deal.id, deal);
    return deal;
  },
  find(id: string): MockDeal | undefined {
    return db().get(id);
  },
  forUser(
    userId: string,
    role: "client" | "provider"
  ): MockDeal[] {
    return Array.from(db().values())
      .filter((d) =>
        role === "client" ? d.client_id === userId : d.provider_id === userId
      )
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
  },
};

/* =====================================================================
   Public projection (REST shape) — drops nothing for now since deals
   are created by their client and most fields are non-sensitive. Real
   backend may strip provider_payout_method etc. depending on viewer role.
   ===================================================================== */
export function projectDeal(d: MockDeal) {
  return {
    id: d.id,
    listing_id: d.listing_id,
    client_id: d.client_id,
    provider_id: d.provider_id,
    status: d.status,
    scope: d.scope,
    urgency: d.urgency,
    deadline_at: d.deadline_at,
    address: d.address,
    phone: d.phone,
    attachment_ids: d.attachment_ids,
    budget_kopecks: d.budget_kopecks,
    fee_kopecks: d.fee_kopecks,
    total_held_kopecks: d.total_held_kopecks,
    hold_id: d.hold_id,
    created_at: d.created_at,
    listing_title_snapshot: d.listing_title_snapshot,
  };
}
export type DealProjection = ReturnType<typeof projectDeal>;
