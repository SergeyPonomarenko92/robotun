import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { confirmUpload } from "../../../_mock/media";

/**
 * POST /api/v1/media/uploads/confirm — Module 6 §4.5.2.
 * Idempotent. Returns 202 with current status.
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
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
