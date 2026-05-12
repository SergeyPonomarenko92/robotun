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
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;
  const isAdmin = auth.user.roles.includes("admin");
  const r = streamBlob(id, auth.user.id, isAdmin);
  if (!r.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // dispute_evidence is never CDN-cached (spec §4.5.3 + DSP-SEC-004).
  return new Response(r.buffer, {
    status: 200,
    headers: {
      "Content-Type": r.mime_type,
      "Content-Disposition": `inline; filename="${encodeURIComponent(r.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
