import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { streamBlob } from "../../../_mock/media";

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
  // private/no-store is the safe default; CDN cache rules per §4.5.3 will be
  // applied per-purpose in Step 3 when the public-active-listing JOIN lands.
  return new Response(r.buffer, {
    status: 200,
    headers: {
      "Content-Type": r.mime_type,
      "Content-Disposition": `inline; filename="${encodeURIComponent(r.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
