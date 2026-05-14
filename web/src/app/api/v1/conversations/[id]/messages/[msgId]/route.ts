import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { deleteMessage, editMessage } from "../../../../_mock/messaging";

type Ctx = { params: Promise<{ id: string; msgId: string }> };

const STATUS_BY_ERROR: Record<string, number> = {
  not_found: 404,
  not_sender: 404, // IDOR collapse — outsiders see "не знайдено"
  edit_window_expired: 409,
  conversation_locked: 409,
  body_empty: 400,
  body_too_long: 400,
};

/**
 * PUT /api/v1/conversations/{id}/messages/{msgId} — edit sender's own
 * message within the 10-min REQ-005 window. Re-runs contact-info detection;
 * may auto-redact the new body.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id, msgId } = await ctx.params;
  let body: { body?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const r = editMessage({
    conversation_id: id,
    message_id: msgId,
    caller_id: auth.user.id,
    body: body.body ?? "",
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      { status: STATUS_BY_ERROR[r.error] ?? 400 }
    );
  }
  return NextResponse.json(r.message);
}

/**
 * DELETE /api/v1/conversations/{id}/messages/{msgId} — soft-delete sender's
 * own message within the 10-min window. body→null, deleted_at set;
 * UI renders "[повідомлення видалено]".
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id, msgId } = await ctx.params;
  const r = deleteMessage({
    conversation_id: id,
    message_id: msgId,
    caller_id: auth.user.id,
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      { status: STATUS_BY_ERROR[r.error] ?? 400 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
