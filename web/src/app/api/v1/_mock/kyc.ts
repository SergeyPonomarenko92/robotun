/**
 * Module 4 mock — KYC application store (Provider verification).
 *
 * Real spec (REQ-001…015) covers a full state machine
 * (not_submitted → submitted → in_review → approved | rejected | expired |
 * cancelled) backed by `kyc_verifications` + `kyc_documents` +
 * `kyc_review_events`. This mock keeps a tiny per-provider snapshot on
 * globalThis so the wizard at /provider/kyc can persist its submission and
 * the dashboard can render the resulting status.
 */

export type KycStatus =
  | "not_submitted"
  | "submitted"
  | "in_review"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export type KycPayoutMethod = "card" | "iban";

export type KycApplication = {
  provider_id: string;
  status: KycStatus;
  doc_type: "passport" | "id_card" | "bio_passport";
  doc_media_ids: string[];
  legal_name: string;
  tax_id: string;
  payout_method: KycPayoutMethod;
  payout_details: {
    card_number?: string;
    iban?: string;
    bank_name: string;
    account_holder: string;
  };
  submitted_at: string;
  reviewed_at: string | null;
  rejection_code: string | null;
  /** REQ-012: count toward lifetime submission_limit. */
  submission_count: number;
  /** REQ-012: 24h cooling-off — set when status flips to 'rejected'. */
  cooling_off_until: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_KYC_APPS__: Map<string, KycApplication> | undefined;
}
function db(): Map<string, KycApplication> {
  if (!globalThis.__ROBOTUN_KYC_APPS__) {
    globalThis.__ROBOTUN_KYC_APPS__ = new Map();
  }
  return globalThis.__ROBOTUN_KYC_APPS__;
}

export type SubmitInput = {
  provider_id: string;
  doc_type: KycApplication["doc_type"];
  doc_media_ids: string[];
  legal_name: string;
  tax_id: string;
  payout_method: KycPayoutMethod;
  payout_details: KycApplication["payout_details"];
};

export type SubmitResult =
  | { ok: true; app: KycApplication }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "already_submitted"
        | "already_approved"
        | "resubmit_too_soon"
        | "submission_limit_reached";
      fields?: Record<string, string>;
      /** Seconds until cooling-off window closes (resubmit_too_soon only). */
      retry_after_seconds?: number;
    };

const COOLING_OFF_MS = 24 * 60 * 60 * 1000;
const SUBMISSION_LIMIT = 5;

function validate(
  input: SubmitInput
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!["passport", "id_card", "bio_passport"].includes(input.doc_type))
    fields.doc_type = "invalid_doc_type";
  if (input.doc_media_ids.length === 0)
    fields.doc_media_ids = "missing_documents";
  if (input.doc_type === "id_card" && input.doc_media_ids.length < 2)
    fields.doc_media_ids = "id_card_requires_both_sides";
  if (input.legal_name.trim().length < 4) fields.legal_name = "too_short";
  // RNOKPP: 10 digits per spec §4.4 (we skip checksum here — mock).
  if (!/^\d{10}$/.test(input.tax_id)) fields.tax_id = "invalid_format";
  const p = input.payout_details;
  if (input.payout_method === "card") {
    if (!p.card_number || p.card_number.replace(/\s/g, "").length < 16)
      fields.card_number = "invalid_card";
  } else if (input.payout_method === "iban") {
    if (!p.iban || p.iban.replace(/\s/g, "").length < 29)
      fields.iban = "invalid_iban";
  }
  if (!p.bank_name.trim()) fields.bank_name = "required";
  if (!p.account_holder.trim()) fields.account_holder = "required";
  return fields;
}

export function submitApplication(input: SubmitInput): SubmitResult {
  const existing = db().get(input.provider_id);
  if (existing?.status === "approved") {
    return { ok: false, error: "already_approved" };
  }
  if (
    existing &&
    (existing.status === "submitted" || existing.status === "in_review")
  ) {
    return { ok: false, error: "already_submitted" };
  }
  // REQ-012: lifetime submission_limit (default 5).
  const prevCount = existing?.submission_count ?? 0;
  if (prevCount >= SUBMISSION_LIMIT) {
    return { ok: false, error: "submission_limit_reached" };
  }
  // REQ-012: 24h cooling-off after a rejection.
  if (existing?.cooling_off_until) {
    const until = new Date(existing.cooling_off_until).getTime();
    if (Date.now() < until) {
      return {
        ok: false,
        error: "resubmit_too_soon",
        retry_after_seconds: Math.ceil((until - Date.now()) / 1000),
      };
    }
  }
  const fields = validate(input);
  if (Object.keys(fields).length > 0) {
    return { ok: false, error: "validation_failed", fields };
  }
  const app: KycApplication = {
    provider_id: input.provider_id,
    status: "submitted",
    doc_type: input.doc_type,
    doc_media_ids: input.doc_media_ids,
    legal_name: input.legal_name.trim(),
    tax_id: input.tax_id,
    payout_method: input.payout_method,
    payout_details: input.payout_details,
    submitted_at: new Date().toISOString(),
    reviewed_at: null,
    rejection_code: null,
    submission_count: prevCount + 1,
    // Carry forward the cooling-off only if still in future (cleared on
    // successful resubmit since we passed the gate above).
    cooling_off_until: null,
  };
  db().set(input.provider_id, app);
  return { ok: true, app };
}

export function getApplication(providerId: string): KycApplication | null {
  return db().get(providerId) ?? null;
}

// ---------------------------------------------------------------------------
// Admin operations (Module 4 REQ-006…008).
// ---------------------------------------------------------------------------

export const REJECTION_CODES = [
  "document_expired",
  "document_unreadable",
  "document_mismatch",
  "selfie_mismatch",
  "data_inconsistency",
  "unsupported_document_type",
  "incomplete_submission",
  "fraud_suspicion",
  "other",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export function listApplicationsByStatus(
  filter?: KycStatus | "open"
): KycApplication[] {
  const all = Array.from(db().values());
  let filtered = all;
  if (filter === "open") {
    filtered = all.filter(
      (a) => a.status === "submitted" || a.status === "in_review"
    );
  } else if (filter) {
    filtered = all.filter((a) => a.status === filter);
  }
  return filtered.sort(
    (a, b) =>
      new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()
  );
}

export function claimApplication(
  providerId: string,
  adminId: string
): KycApplication | { error: "not_found" | "invalid_state" } {
  const row = db().get(providerId);
  if (!row) return { error: "not_found" };
  if (row.status === "in_review") return row; // idempotent re-claim
  if (row.status !== "submitted") return { error: "invalid_state" };
  row.status = "in_review";
  void adminId; // reviewed_by tracking омитнено в моку — real backend пише
  return row;
}

export type ApproveResult =
  | { ok: true; app: KycApplication }
  | { ok: false; error: "not_found" | "invalid_state" };

export function approveApplication(providerId: string): ApproveResult {
  const row = db().get(providerId);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "submitted" && row.status !== "in_review") {
    return { ok: false, error: "invalid_state" };
  }
  row.status = "approved";
  row.reviewed_at = new Date().toISOString();
  return { ok: true, app: row };
}

export type RejectResult =
  | { ok: true; app: KycApplication }
  | { ok: false; error: "not_found" | "invalid_state" | "invalid_code" };

export function rejectApplication(
  providerId: string,
  code: string,
  note: string | null
): RejectResult {
  const row = db().get(providerId);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "submitted" && row.status !== "in_review") {
    return { ok: false, error: "invalid_state" };
  }
  if (!(REJECTION_CODES as readonly string[]).includes(code)) {
    return { ok: false, error: "invalid_code" };
  }
  row.status = "rejected";
  row.rejection_code = code;
  row.reviewed_at = new Date().toISOString();
  row.cooling_off_until = new Date(Date.now() + COOLING_OFF_MS).toISOString();
  void note; // omitting note storage in the mock projection
  return { ok: true, app: row };
}
