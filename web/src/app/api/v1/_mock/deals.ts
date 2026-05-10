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

export type TransitionError =
  | "not_found"
  | "forbidden"
  | "invalid_state";

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
  /** Module 3 §4.5 transitions (mock subset).
   *  pending → active (provider accept)
   *  pending → cancelled (provider reject OR client cancel)
   *  Other transitions out of scope for the viewer wiring. */
  transition(
    id: string,
    callerId: string,
    action: "accept" | "reject" | "cancel"
  ): MockDeal | { error: TransitionError } {
    const d = db().get(id);
    if (!d) return { error: "not_found" };

    if (action === "accept" || action === "reject") {
      if (d.provider_id !== callerId) return { error: "forbidden" };
      if (d.status !== "pending") return { error: "invalid_state" };
      d.status = action === "accept" ? "active" : "cancelled";
      return d;
    }
    if (action === "cancel") {
      if (d.client_id !== callerId) return { error: "forbidden" };
      if (d.status !== "pending") return { error: "invalid_state" };
      d.status = "cancelled";
      return d;
    }
    return { error: "invalid_state" };
  },
};

/* =====================================================================
   Public projection (REST shape) — embeds party display info so /deals/:id
   can render DealHeader without a separate users JOIN. Real backend would
   strip provider_payout_method etc. depending on viewer role.
   ===================================================================== */
import { store as usersStore, type MockUser } from "./store";
import { findListing } from "./listings";

type PartyEmbed = {
  id: string;
  display_name: string;
  avatar_url?: string;
  kyc_verified: boolean;
};

function embedClient(userId: string): PartyEmbed {
  const u = usersStore.findUserById(userId);
  if (u) {
    return {
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      kyc_verified: u.kyc_status === "approved",
    };
  }
  // Unknown — graceful fallback (deleted user, mock-only)
  return {
    id: userId,
    display_name: "Користувач",
    kyc_verified: false,
  };
}

function embedProvider(providerId: string, listingId: string): PartyEmbed {
  // Try users first (real seeded provider)
  const u = usersStore.findUserById(providerId);
  if (u) {
    return {
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      kyc_verified: u.kyc_status === "approved",
    };
  }
  // Listings have synthetic provider IDs (uuid5 from name) that don't exist
  // in the users table — fall back to the listing's provider snapshot.
  const l = findListing(listingId);
  if (l) {
    return {
      id: providerId,
      display_name: l.provider.name,
      avatar_url: l.provider.avatar_url,
      kyc_verified: l.provider.kyc_verified,
    };
  }
  return { id: providerId, display_name: "Виконавець", kyc_verified: false };
}

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
    /** Embedded party display blocks (Module 3 spec leaves this to projection
     *  layer — keeping read-side denormalized avoids a JOIN in the hot path). */
    client: embedClient(d.client_id),
    provider: embedProvider(d.provider_id, d.listing_id),
  };
}

// MockUser used only inside this module — silence unused-import in some builds
void (null as unknown as MockUser);

export type DealProjection = ReturnType<typeof projectDeal>;
