import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { streamBlob, getMediaMeta } from "../../../_mock/media";
import { logAdminAction } from "../../../_mock/admin_audit";

/**
 * GET /api/v1/media/{id}/stream — Module 6 §4.5.3.
 * Step 1: uploader-only authorization for dispute_evidence purpose.
 * (Admin streaming + per-purpose rules wired in Step 2.)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Anonymous access is allowed for listing_*/avatar (per spec §4.5.3). The
  // authorize() result is only used for private-purpose checks; failure here
  // does not short-circuit, since public-purpose lookup is anonymous.
  const auth = authorize(req.headers.get("authorization"));
  const callerId = "error" in auth ? null : auth.user.id;
  const isAdmin = "error" in auth ? false : auth.user.roles.includes("admin");
  const { id } = await params;
  const r = streamBlob(id, callerId, isAdmin);
  if (!r.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // SEC-006: KYC document reads by a reviewer (mock: admin role) must be
  // appended to the audit trail. Owner self-reads are not audited.
  if (callerId && isAdmin) {
    const meta = getMediaMeta(id, callerId, true);
    if (meta.ok && meta.media.purpose === "kyc_document") {
      logAdminAction({
        actor_admin_id: callerId,
        action: "kyc.document_streamed",
        target_type: "media",
        target_id: id,
        target_user_id: null,
        metadata: {
          mime_type: meta.media.mime_type,
          byte_size: meta.media.byte_size,
        },
      });
    }
  }
  return new Response(r.buffer, {
    status: 200,
    headers: {
      "Content-Type": r.mime_type,
      "Content-Disposition": `inline; filename="${encodeURIComponent(r.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
