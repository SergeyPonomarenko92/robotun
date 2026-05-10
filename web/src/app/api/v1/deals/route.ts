import { NextResponse } from "next/server";
import { authorize } from "../_mock/store";
import { findListing } from "../_mock/listings";
import { dealsStore, projectDeal, type Urgency } from "../_mock/deals";

const SCOPE_MIN = 40;
const SCOPE_MAX = 1500;
const BUDGET_MIN_KOPECKS = 5000; // 50 ₴
const URGENCIES: Urgency[] = ["today", "tomorrow", "week", "later"];

type CreateDealBody = {
  listing_id?: string;
  scope?: string;
  urgency?: string;
  deadline_at?: string | null;
  address?: string;
  phone?: string;
  budget_kopecks?: number;
  attachment_ids?: string[];
  escrow_confirmed?: boolean;
  terms_confirmed?: boolean;
};

export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const me = auth.user;

  let body: CreateDealBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Validation — server is source of truth even though FE pre-validates.
  const errors: Record<string, string> = {};
  const listing = body.listing_id ? findListing(body.listing_id) : undefined;
  if (!listing) errors.listing_id = "listing_not_found";
  if (!body.scope || body.scope.trim().length < SCOPE_MIN)
    errors.scope = "too_short";
  else if (body.scope.length > SCOPE_MAX) errors.scope = "too_long";
  if (!body.urgency || !URGENCIES.includes(body.urgency as Urgency))
    errors.urgency = "invalid";
  if (!body.address || body.address.trim().length < 1)
    errors.address = "required";
  if (!body.phone || body.phone.trim().length < 4) errors.phone = "required";
  if (!body.budget_kopecks || body.budget_kopecks < BUDGET_MIN_KOPECKS)
    errors.budget_kopecks = "below_min";
  if (!body.escrow_confirmed) errors.escrow_confirmed = "required";
  if (!body.terms_confirmed) errors.terms_confirmed = "required";

  if (Object.keys(errors).length > 0) {
    return NextResponse.json(
      { error: "validation_failed", fields: errors },
      { status: 400 }
    );
  }

  if (listing!.provider.id === me.id) {
    return NextResponse.json(
      { error: "cannot_deal_with_self" },
      { status: 422 }
    );
  }

  const deal = dealsStore.insert({
    listing_id: listing!.id,
    client_id: me.id,
    provider_id: listing!.provider.id,
    scope: body.scope!.trim(),
    urgency: body.urgency as Urgency,
    deadline_at: body.deadline_at?.trim() ? body.deadline_at : null,
    address: body.address!.trim(),
    phone: body.phone!.trim(),
    attachment_ids: body.attachment_ids ?? [],
    budget_kopecks: body.budget_kopecks!,
    listing_title_snapshot: listing!.title,
  });

  return NextResponse.json(projectDeal(deal), { status: 201 });
}
