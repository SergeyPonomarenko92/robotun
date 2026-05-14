import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { submitApplication } from "../../../_mock/kyc";
import { validateAttachments } from "../../../_mock/media";

/**
 * POST /api/v1/kyc/me/submissions — Module 4 REQ-003.
 *
 * Spec-aligned validation:
 *   - doc_media_ids ownership + purpose='kyc_document' + status='ready'
 *     (mock validateAttachments)
 *   - id_card requires both sides
 *   - RNOKPP 10 digits (mock skips full checksum)
 *   - legal_name min 4 chars
 *   - payout_method specifics (card 16-digit, IBAN 29-char)
 *
 * Cooling-off (REQ-012) + submission_limit (max 5) not enforced in this
 * mock; real backend gates resubmits. Approval flow is admin-side (covered
 * by Module 12 admin tools, deferred for KYC v2).
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.has_provider_role) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: {
    doc_type?: "passport" | "id_card" | "bio_passport";
    doc_media_ids?: string[];
    legal_name?: string;
    tax_id?: string;
    payout_method?: "card" | "iban";
    payout_details?: {
      card_number?: string;
      iban?: string;
      bank_name?: string;
      account_holder?: string;
    };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // Sanitize input before validating.
  const mediaIds = Array.isArray(body.doc_media_ids) ? body.doc_media_ids : [];
  // Attachment ownership / purpose / status check (mock §4.5.2).
  if (mediaIds.length > 0) {
    const v = validateAttachments(mediaIds, auth.user.id, "kyc_document");
    if (!v.valid) {
      return NextResponse.json(
        {
          error: "validation_failed",
          fields: { doc_media_ids: "invalid_attachments" },
        },
        { status: 400 }
      );
    }
  }

  const result = submitApplication({
    provider_id: auth.user.id,
    doc_type: body.doc_type ?? "id_card",
    doc_media_ids: mediaIds,
    legal_name: body.legal_name ?? "",
    tax_id: body.tax_id ?? "",
    payout_method: body.payout_method ?? "card",
    payout_details: {
      card_number: body.payout_details?.card_number,
      iban: body.payout_details?.iban,
      bank_name: body.payout_details?.bank_name ?? "",
      account_holder: body.payout_details?.account_holder ?? "",
    },
  });
  if (!result.ok) {
    if (result.error === "validation_failed") {
      return NextResponse.json(
        { error: "validation_failed", fields: result.fields },
        { status: 400 }
      );
    }
    if (result.error === "already_submitted") {
      return NextResponse.json({ error: "already_submitted" }, { status: 409 });
    }
    return NextResponse.json({ error: "already_approved" }, { status: 409 });
  }
  return NextResponse.json(
    {
      provider_id: result.app.provider_id,
      status: result.app.status,
      submitted_at: result.app.submitted_at,
    },
    { status: 201 }
  );
}
