import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { initiateUpload } from "../../../../_mock/media";

/**
 * POST /api/v1/kyc/me/uploads/initiate — Module 6 REQ-007.
 * Thin proxy that forces purpose='kyc_document' regardless of body input.
 * Provider role required (only providers go through KYC for payout).
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.has_provider_role) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { mime_type?: string; byte_size?: number; original_filename?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    typeof body.mime_type !== "string" ||
    typeof body.byte_size !== "number" ||
    typeof body.original_filename !== "string"
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const r = initiateUpload({
    caller_user_id: auth.user.id,
    purpose: "kyc_document", // injected per REQ-007
    mime_type: body.mime_type,
    byte_size: body.byte_size,
    original_filename: body.original_filename,
  });
  if (!r.ok) {
    if (r.error === "mime_not_allowed") {
      return NextResponse.json(
        { error: "mime_not_allowed", allowed: r.allowed },
        { status: 400 }
      );
    }
    if (r.error === "size_exceeded") {
      return NextResponse.json(
        { error: "size_exceeded", max_bytes: r.max_bytes },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: r.error }, { status: 400 });
  }
  return NextResponse.json(
    {
      media_id: r.media_id,
      method: r.method,
      url: r.url,
      fields: r.fields,
      expires_at: r.expires_at,
    },
    { status: 201 }
  );
}
