import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { getMediaMeta, softDeleteMedia } from "../../_mock/media";

/**
 * GET /api/v1/media/{id} — sanitized metadata (spec §4.5.4).
 * NO storage_key / bucket_alias / presigned URLs in response body (SEC-004).
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
  const r = getMediaMeta(id, auth.user.id);
  if (!r.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r.media);
}

/**
 * DELETE /api/v1/media/{id} — soft delete (spec §4.5 REQ-005).
 * Used by useUploader.removeFile to clean up orphans during chip removal.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;
  const ok = softDeleteMedia(id, auth.user.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
