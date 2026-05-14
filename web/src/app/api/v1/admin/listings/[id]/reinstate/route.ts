import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import {
  findListing,
  isListingArchived,
  reinstateListing,
} from "../../../../_mock/listings";
import { logAdminAction } from "../../../../_mock/admin_audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/admin/listings/{id}/reinstate — undo a force-archive.
 * 409 if listing is not currently archived.
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  let body: { reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const reason = (body.reason ?? "").trim();
  if (reason.length < 10) {
    return NextResponse.json(
      { error: "reason_too_short" },
      { status: 400 }
    );
  }
  const target = findListing(id);
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!isListingArchived(id)) {
    return NextResponse.json(
      { error: "not_archived" },
      { status: 409 }
    );
  }
  reinstateListing(id);
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "listing.reinstate",
    target_type: "listing",
    target_id: id,
    target_user_id: target.provider.id,
    metadata: { reason, title: target.title },
  });
  return NextResponse.json({ id, archived: false });
}
