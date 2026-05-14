import { NextResponse } from "next/server";
import { authorize, store } from "../_mock/store";
import {
  blockerOf,
  listConversationsForUser,
  unreadCountFor,
  upsertConversation,
  type ConversationScope,
} from "../_mock/messaging";

function projectionFor(callerId: string, c: ReturnType<typeof listConversationsForUser>[number]) {
  const counterpartyId =
    c.client_id === callerId ? c.provider_id : c.client_id;
  const counterparty = store.findUserById(counterpartyId);
  return {
    id: c.id,
    scope: c.scope,
    listing_id: c.listing_id,
    deal_id: c.deal_id,
    status: c.status,
    counterparty: counterparty
      ? {
          id: counterparty.id,
          display_name: counterparty.display_name,
          avatar_url: counterparty.avatar_url,
          kyc_verified: counterparty.kyc_status === "approved",
        }
      : null,
    last_message_at: c.last_message_at,
    last_message_preview: c.last_message_preview,
    unread_count: unreadCountFor(callerId, c.id),
    blocked_by: blockerOf(c.id),
    created_at: c.created_at,
  };
}

/**
 * GET /api/v1/conversations — list caller's conversations.
 * Optional ?scope=pre_deal|deal. Cursor pagination omitted in mock (full list).
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") as ConversationScope | null;
  const rows = listConversationsForUser(auth.user.id, scope ?? undefined);
  return NextResponse.json({
    items: rows.map((c) => projectionFor(auth.user.id, c)),
  });
}

/**
 * POST /api/v1/conversations — idempotent upsert per REQ-003.
 *
 * Body shapes:
 *   { scope: 'pre_deal', listing_id, counterparty_user_id }
 *   { scope: 'deal',     deal_id,    counterparty_user_id }
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: {
    scope?: ConversationScope;
    listing_id?: string;
    deal_id?: string;
    counterparty_user_id?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.scope || (body.scope !== "pre_deal" && body.scope !== "deal")) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }
  if (!body.counterparty_user_id) {
    return NextResponse.json(
      { error: "counterparty_required" },
      { status: 400 }
    );
  }
  if (body.counterparty_user_id === auth.user.id) {
    return NextResponse.json(
      { error: "cannot_message_self" },
      { status: 422 }
    );
  }
  // REQ-002 / REQ-001 lite check: counterparty must exist as a user.
  if (!store.findUserById(body.counterparty_user_id)) {
    return NextResponse.json({ error: "counterparty_not_found" }, { status: 404 });
  }
  const c =
    body.scope === "pre_deal"
      ? upsertConversation({
          scope: "pre_deal",
          caller_user_id: auth.user.id,
          counterparty_user_id: body.counterparty_user_id,
          listing_id: body.listing_id ?? "",
        })
      : upsertConversation({
          scope: "deal",
          caller_user_id: auth.user.id,
          counterparty_user_id: body.counterparty_user_id,
          deal_id: body.deal_id ?? "",
        });
  if (
    (body.scope === "pre_deal" && !body.listing_id) ||
    (body.scope === "deal" && !body.deal_id)
  ) {
    return NextResponse.json(
      { error: "scope_ref_required" },
      { status: 400 }
    );
  }
  return NextResponse.json(projectionFor(auth.user.id, c), { status: 201 });
}
