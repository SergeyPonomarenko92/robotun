import { NextResponse } from "next/server";
import { authorize, store } from "../../_mock/store";
import {
  findConversation,
  isParty,
  unreadCountFor,
} from "../../_mock/messaging";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const c = findConversation(id);
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isParty(c, auth.user.id)) {
    // Collapse forbidden→404 (IDOR enumeration guard).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const counterpartyId =
    c.client_id === auth.user.id ? c.provider_id : c.client_id;
  const counterparty = store.findUserById(counterpartyId);
  return NextResponse.json({
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
    unread_count: unreadCountFor(auth.user.id, c.id),
    created_at: c.created_at,
  });
}
