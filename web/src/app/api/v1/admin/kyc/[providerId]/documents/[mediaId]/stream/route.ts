import { NextResponse } from "next/server";
import { authorize } from "../../../../../../_mock/store";
import { getApplication } from "../../../../../../_mock/kyc";
import { streamBlob } from "../../../../../../_mock/media";
import { logAdminAction } from "../../../../../../_mock/admin_audit";

type Ctx = { params: Promise<{ providerId: string; mediaId: string }> };

/**
 * GET /api/v1/admin/kyc/{providerId}/documents/{mediaId}/stream
 *
 * Module 4 REQ-013 reviewer streaming proxy. Adds two guards vs. the
 * generic /media/{id}/stream path:
 *   1. media MUST belong to that provider's current KYC application
 *      (denies pivot from one application's UUID to another provider's
 *      document — defense-in-depth against URL guessing).
 *   2. Logs the access as `kyc.document_streamed` with both target_id
 *      (the media) and target_user_id (the reviewed provider) so per-
 *      provider audit timelines surface the read.
 */
export async function GET(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { providerId, mediaId } = await ctx.params;
  const app = getApplication(providerId);
  if (!app || !app.doc_media_ids.includes(mediaId)) {
    // 404 even on cross-provider access (don't leak existence).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const r = streamBlob(mediaId, auth.user.id, true);
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 404 });
  }
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "kyc.document_streamed",
    target_type: "media",
    target_id: mediaId,
    target_user_id: providerId,
    metadata: { application_status: app.status },
  });
  return new NextResponse(r.buffer, {
    status: 200,
    headers: {
      "content-type": r.mime_type,
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${r.filename.replace(/"/g, "")}"`,
    },
  });
}
