import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import {
  initiateUpload,
  ALLOWED_PURPOSES,
  type MediaPurpose,
} from "../../../_mock/media";

/**
 * POST /api/v1/media/uploads/initiate — Module 6 §4.5.1
 * Returns presigned-POST envelope. For mock: `fields` is empty and `url`
 * points at our own `POST /api/v1/media/uploads/{id}/blob` endpoint.
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: {
    purpose?: string;
    mime_type?: string;
    byte_size?: number;
    original_filename?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    !body.purpose ||
    !ALLOWED_PURPOSES.has(body.purpose as MediaPurpose) ||
    typeof body.mime_type !== "string" ||
    typeof body.byte_size !== "number" ||
    typeof body.original_filename !== "string"
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const r = initiateUpload({
    caller_user_id: auth.user.id,
    purpose: body.purpose as MediaPurpose,
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
