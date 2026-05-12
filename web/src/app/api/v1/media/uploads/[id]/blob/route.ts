import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { storeBlob } from "../../../../_mock/media";

/**
 * POST /api/v1/media/uploads/{id}/blob — mock stand-in for S3 presigned POST.
 * Accepts multipart/form-data with a `file` part (matching real S3 POST
 * shape). On swap to S3, the client targets s3.amazonaws.com with the same
 * FormData layout — only the URL changes.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }
  const buffer = await file.arrayBuffer();
  const r = storeBlob(id, auth.user.id, buffer);
  if (!r.ok) {
    if (r.error === "size_mismatch") {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (r.error === "already_confirmed") {
      return NextResponse.json({ error: "already_confirmed" }, { status: 409 });
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
