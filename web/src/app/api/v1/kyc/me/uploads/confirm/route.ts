import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { confirmUpload, getMediaMeta } from "../../../../_mock/media";

/**
 * POST /api/v1/kyc/me/uploads/confirm — Module 6 REQ-007.
 * Thin proxy. The confirm internals also gate on purpose='kyc_document' via
 * an explicit check (defense-in-depth: this proxy verifies the row's purpose
 * before calling confirmUpload, so a caller can't reuse this endpoint to
 * confirm a non-KYC media row).
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.has_provider_role) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { media_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.media_id !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  // Verify purpose before confirming — caller MUST own a kyc_document row.
  const meta = getMediaMeta(body.media_id, auth.user.id);
  if (!meta.ok || meta.media.purpose !== "kyc_document") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const r = confirmUpload(body.media_id, auth.user.id);
  if (!r.ok) {
    if (r.error === "blob_missing") {
      return NextResponse.json({ error: "blob_missing" }, { status: 422 });
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      media_id: r.media.id,
      status: r.media.status,
      ready_at: r.media.ready_at,
    },
    { status: 202 }
  );
}
