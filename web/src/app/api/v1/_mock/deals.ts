/**
 * Module 3 mock — Deal lifecycle state in-memory.
 *
 * State machine (CLAUDE.md):
 *   pending → active → in_review → completed | disputed | cancelled
 *
 * Client initiates (status='pending'), Provider must confirm to advance to
 * 'active'. KYC required for payout (Module 4), NOT for deal creation.
 */

import { paymentHooks } from "./payments";

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

  /** Module 3 §REQ-009 / PAT-003 — mutual cancel from `active`.
   *  Each party records its consent independently; when both are set the
   *  transition() helper flips status to 'cancelled' atomically. Requests
   *  lapse after 48h (CON-010 / spec §4.5). Spec stores ISO timestamps
   *  in two columns; mock mirrors that. */
  cancel_requested_by_client_at: string | null;
  cancel_requested_by_provider_at: string | null;
  cancel_request_reason: string | null;

  /** Module 14 §4 — dispute_evidence. Spec uses a separate table with one
   *  row per party (UNIQUE(deal_id, party_role)); mock embeds two slots
   *  for simplicity. Visibility rule: counterparty statement HIDDEN until
   *  provider responds OR 3-day window closes (handled at projection
   *  layer). Resolution is recorded on a separate field below. */
  dispute_evidence_client: DealEvidence | null;
  dispute_evidence_provider: DealEvidence | null;
  dispute_resolution: DealResolution | null;
};

export type DisputeEvidenceError =
  | "not_found"
  | "forbidden"
  | "invalid_state"
  | "already_submitted"
  | "validation_failed";

const DISPUTE_REASONS: ReadonlyArray<DisputeReason> = [
  "not_delivered",
  "partial_work",
  "wrong_quality",
  "out_of_scope",
  "client_withdrew",
  "other",
];

const STATEMENT_MIN = 30;
const STATEMENT_MAX = 4000;
const ATTACHMENT_MAX = 5;

/** Module 14 §4 — submit dispute evidence (one shot per party). */
export function submitDisputeEvidence(
  id: string,
  callerId: string,
  body: {
    reason: string;
    statement: string;
    attachment_ids?: string[];
  },
  demoActAsProvider = false
):
  | { ok: true; deal: MockDeal }
  | { error: DisputeEvidenceError; fields?: Record<string, string> } {
  const d = db().get(id);
  if (!d) return { error: "not_found" };
  if (d.status !== "disputed") return { error: "invalid_state" };

  const isClient = d.client_id === callerId;
  const isProvider = d.provider_id === callerId || demoActAsProvider;
  if (!isClient && !isProvider) return { error: "forbidden" };

  // Validate.
  const fields: Record<string, string> = {};
  const statement = (body.statement ?? "").trim();
  const reason = body.reason as DisputeReason;
  if (!DISPUTE_REASONS.includes(reason)) fields.reason = "reason_invalid";
  if (statement.length < STATEMENT_MIN) fields.statement = "statement_too_short";
  else if (statement.length > STATEMENT_MAX)
    fields.statement = "statement_too_long";
  const attachments = body.attachment_ids ?? [];
  if (attachments.length > ATTACHMENT_MAX)
    fields.attachment_ids = "too_many_attachments";
  if (Object.keys(fields).length > 0) {
    return { error: "validation_failed", fields };
  }

  const slot = isClient ? "dispute_evidence_client" : "dispute_evidence_provider";
  if (d[slot]) return { error: "already_submitted" };

  d[slot] = {
    reason,
    statement,
    attachment_ids: attachments,
    submitted_at: new Date().toISOString(),
  };
  if (isProvider && demoActAsProvider) d.provider_id = callerId;
  return { ok: true, deal: d };
}

export type DisputeResolveError =
  | "not_found"
  | "forbidden"
  | "invalid_state"
  | "validation_failed";

/** Module 14 §4 — admin resolution. Verdict drives the next deal status
 *  AND a money path: refund_client → 'cancelled' + refund hook;
 *  release_to_provider → 'completed' + capture hook. */
export function resolveDispute(
  id: string,
  adminId: string,
  body: { verdict: string; reason: string }
):
  | { ok: true; deal: MockDeal }
  | { error: DisputeResolveError; fields?: Record<string, string> } {
  const d = db().get(id);
  if (!d) return { error: "not_found" };
  if (d.status !== "disputed") return { error: "invalid_state" };

  const fields: Record<string, string> = {};
  const reason = (body.reason ?? "").trim();
  if (reason.length < 10) fields.reason = "reason_too_short";
  if (body.verdict !== "refund_client" && body.verdict !== "release_to_provider")
    fields.verdict = "verdict_invalid";
  if (Object.keys(fields).length > 0) {
    return { error: "validation_failed", fields };
  }

  d.dispute_resolution = {
    verdict: body.verdict as DealResolution["verdict"],
    resolver_admin_id: adminId,
    reason,
    resolved_at: new Date().toISOString(),
  };

  if (body.verdict === "refund_client") {
    d.status = "cancelled";
    paymentHooks.onDealRefunded({ ...d, hadHold: true });
  } else {
    d.status = "completed";
    paymentHooks.onDealCompleted(d);
  }
  return { ok: true, deal: d };
}

export type DisputeReason =
  | "not_delivered"
  | "partial_work"
  | "wrong_quality"
  | "out_of_scope"
  | "client_withdrew"
  | "other";

export type DealEvidence = {
  reason: DisputeReason;
  statement: string;
  attachment_ids: string[];
  submitted_at: string;
};

export type DealResolution = {
  verdict: "refund_client" | "release_to_provider";
  resolver_admin_id: string;
  reason: string;
  resolved_at: string;
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
  insert(
    input: Omit<
      MockDeal,
      | "id"
      | "status"
      | "created_at"
      | "fee_kopecks"
      | "total_held_kopecks"
      | "hold_id"
      | "cancel_requested_by_client_at"
      | "cancel_requested_by_provider_at"
      | "cancel_request_reason"
      | "dispute_evidence_client"
      | "dispute_evidence_provider"
      | "dispute_resolution"
    >
  ): MockDeal {
    const fee = Math.round(input.budget_kopecks * PLATFORM_FEE_BPS / 10_000);
    const deal: MockDeal = {
      ...input,
      id: uuid(),
      status: "pending",
      created_at: new Date().toISOString(),
      fee_kopecks: fee,
      total_held_kopecks: input.budget_kopecks + fee,
      hold_id: "hold_" + uuid().replace(/-/g, "").slice(0, 16),
      cancel_requested_by_client_at: null,
      cancel_requested_by_provider_at: null,
      cancel_request_reason: null,
      dispute_evidence_client: null,
      dispute_evidence_provider: null,
      dispute_resolution: null,
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
  /** "My deals" list for a caller: deals where caller is client OR provider.
   *  Demo override: a seeded provider user (whose UUID does not match any
   *  synthetic listing.provider_id) cannot otherwise see pending deals it
   *  hasn't accepted yet. Pass `demoActAsProvider=true` to widen the result
   *  to ALL deals — mirrors the override in `transition()`. Real backend has
   *  a real FK and does not need this. */
  forCaller(callerId: string, demoActAsProvider = false): MockDeal[] {
    const all = Array.from(db().values());
    const filtered = demoActAsProvider
      ? all
      : all.filter(
          (d) => d.client_id === callerId || d.provider_id === callerId
        );
    return filtered.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  },
  /** Module 3 §4.5 transitions (mock — happy-path subset).
   *  pending → active     (provider: accept)
   *  pending → cancelled  (provider: reject  |  client: cancel)
   *  active  → in_review  (provider: submit)
   *  in_review → completed (client: approve)
   *  in_review → disputed  (client: dispute)
   *
   *  Out of scope: mutual cancel (cancel-request handshake), 24h grace
   *  dispute, admin resolve/ask-evidence/escalate, post-completed review.
   *
   *  Demo override: `demoActAsProvider` lets the seeded provider@robotun.dev
   *  user drive any deal's provider role, since synthetic listing-provider
   *  IDs (uuid5 from name) don't match real seeded user UUIDs. Real backend
   *  has FK provider_id → users.id with no such bridge needed. */
  transition(
    id: string,
    callerId: string,
    action: DealAction,
    demoActAsProvider = false
  ): MockDeal | { error: TransitionError } {
    const d = db().get(id);
    if (!d) return { error: "not_found" };

    const isProvider = d.provider_id === callerId || demoActAsProvider;
    const isClient = d.client_id === callerId;

    switch (action) {
      case "accept":
      case "reject":
        if (!isProvider) return { error: "forbidden" };
        if (d.status !== "pending") return { error: "invalid_state" };
        d.status = action === "accept" ? "active" : "cancelled";
        if (action === "accept") {
          if (demoActAsProvider) {
            // Persist the demo override so subsequent provider-only actions
            // (submit) work without needing the override flag again.
            d.provider_id = callerId;
          }
          paymentHooks.onDealAccepted(d);
        }
        return d;

      case "cancel":
        if (!isClient) return { error: "forbidden" };
        if (d.status !== "pending") return { error: "invalid_state" };
        d.status = "cancelled";
        // From pending: never had a hold (provider hadn't accepted yet).
        return d;

      case "submit":
        if (!isProvider) return { error: "forbidden" };
        if (d.status !== "active") return { error: "invalid_state" };
        d.status = "in_review";
        return d;

      case "approve":
        if (!isClient) return { error: "forbidden" };
        if (d.status !== "in_review") return { error: "invalid_state" };
        d.status = "completed";
        paymentHooks.onDealCompleted(d);
        return d;

      case "dispute":
        if (!isClient) return { error: "forbidden" };
        if (d.status !== "in_review") return { error: "invalid_state" };
        d.status = "disputed";
        return d;
    }
  },
};

export type DealAction =
  | "accept"
  | "reject"
  | "cancel"
  | "submit"
  | "approve"
  | "dispute";

export type CancelRequestAction = "request" | "revoke";

export type CancelRequestError =
  | "not_found"
  | "forbidden"
  | "invalid_state"
  | "no_active_request";

const CANCEL_REQUEST_TTL_MS = 48 * 60 * 60 * 1000;

/** Returns true if the timestamp is set AND inside the 48h window. */
function isLiveCancelTimestamp(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < CANCEL_REQUEST_TTL_MS;
}

/** Read effective request state, expiring lapsed timestamps in-place.
 *  Real backend does this via the idx_deals_cancel_expiry sweep job (§4.11);
 *  mock just clears on read so the UI never sees a stale 48h+ request. */
function reapExpiredCancel(d: MockDeal): void {
  if (
    d.cancel_requested_by_client_at &&
    !isLiveCancelTimestamp(d.cancel_requested_by_client_at)
  ) {
    d.cancel_requested_by_client_at = null;
  }
  if (
    d.cancel_requested_by_provider_at &&
    !isLiveCancelTimestamp(d.cancel_requested_by_provider_at)
  ) {
    d.cancel_requested_by_provider_at = null;
  }
  if (
    !d.cancel_requested_by_client_at &&
    !d.cancel_requested_by_provider_at
  ) {
    d.cancel_request_reason = null;
  }
}

/** Module 3 §REQ-009 — mutual cancel from `active` (PAT-003).
 *  request: caller records their consent column; if the other party's column
 *  is already non-null (within TTL), atomically flip status='cancelled'.
 *  revoke: caller clears their own column; allowed only while status='active'
 *  and caller's column is set.
 *
 *  Returns the updated deal on success, or an error code. Reason is captured
 *  only on the first 'request' call (overwritten if both clear and re-request).
 *
 *  Demo override `demoActAsProvider` mirrors transition()'s widening. */
export function cancelRequestTransition(
  id: string,
  callerId: string,
  action: CancelRequestAction,
  reason: string | null,
  demoActAsProvider = false
): MockDeal | { error: CancelRequestError } {
  const d = db().get(id);
  if (!d) return { error: "not_found" };

  reapExpiredCancel(d);

  const isClient = d.client_id === callerId;
  const isProvider = d.provider_id === callerId || demoActAsProvider;
  if (!isClient && !isProvider) return { error: "forbidden" };

  if (action === "request") {
    if (d.status !== "active") return { error: "invalid_state" };
    const nowIso = new Date().toISOString();
    if (isClient) {
      d.cancel_requested_by_client_at = nowIso;
    } else {
      d.cancel_requested_by_provider_at = nowIso;
      if (demoActAsProvider) d.provider_id = callerId;
    }
    if (reason && !d.cancel_request_reason) {
      d.cancel_request_reason = reason.slice(0, 500);
    }
    // Atomic transition when both sides agree.
    if (
      d.cancel_requested_by_client_at &&
      d.cancel_requested_by_provider_at
    ) {
      d.status = "cancelled";
      // Hold was created on accept (status transitioned pending->active);
      // mutual cancel from active → release it.
      paymentHooks.onDealRefunded({ ...d, hadHold: true });
    }
    return d;
  }

  // revoke
  if (d.status !== "active") return { error: "invalid_state" };
  const mine = isClient
    ? d.cancel_requested_by_client_at
    : d.cancel_requested_by_provider_at;
  if (!mine) return { error: "no_active_request" };
  if (isClient) {
    d.cancel_requested_by_client_at = null;
  } else {
    d.cancel_requested_by_provider_at = null;
  }
  if (
    !d.cancel_requested_by_client_at &&
    !d.cancel_requested_by_provider_at
  ) {
    d.cancel_request_reason = null;
  }
  return d;
}

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
    cancel_requested_by_client_at: d.cancel_requested_by_client_at,
    cancel_requested_by_provider_at: d.cancel_requested_by_provider_at,
    cancel_request_reason: d.cancel_request_reason,
    /** Module 14 visibility rule: counterparty statement is HIDDEN until the
     *  provider also submits OR 3 days after dispute opened. We compute the
     *  visibility flag here so the projection ships either the full evidence
     *  or a redacted placeholder. */
    dispute_evidence_client: visibleEvidence(d, "client"),
    dispute_evidence_provider: visibleEvidence(d, "provider"),
    dispute_evidence_visibility: evidenceVisibility(d),
    dispute_resolution: d.dispute_resolution,
    /** Embedded party display blocks (Module 3 spec leaves this to projection
     *  layer — keeping read-side denormalized avoids a JOIN in the hot path). */
    client: embedClient(d.client_id),
    provider: embedProvider(d.provider_id, d.listing_id),
  };
}

const DISPUTE_RESPONSE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function evidenceVisibility(d: MockDeal): "open" | "redacted" | "revealed" {
  if (!d.dispute_evidence_client) return "open";
  if (d.dispute_evidence_provider) return "revealed";
  const submittedAt = new Date(
    d.dispute_evidence_client.submitted_at
  ).getTime();
  if (Date.now() - submittedAt >= DISPUTE_RESPONSE_WINDOW_MS) return "revealed";
  return "redacted";
}

function visibleEvidence(
  d: MockDeal,
  role: "client" | "provider"
): DealEvidence | null {
  const ev =
    role === "client" ? d.dispute_evidence_client : d.dispute_evidence_provider;
  return ev;
}

// MockUser used only inside this module — silence unused-import in some builds
void (null as unknown as MockUser);

export type DealProjection = ReturnType<typeof projectDeal>;
