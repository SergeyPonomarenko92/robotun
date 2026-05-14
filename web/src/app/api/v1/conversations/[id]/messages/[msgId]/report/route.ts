import { NextResponse } from "next/server";
import { authorize } from "../../../../../_mock/store";
import {
  reportMessage,
  type MessageReport,
} from "../../../../../_mock/messaging";

type Ctx = { params: Promise<{ id: string; msgId: string }> };

const VALID_REASONS: ReadonlySet<MessageReport["reason"]> = new Set([
  "spam",
  "harassment",
  "contact_info",
  "inappropriate",
  "other",
]);

export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id, msgId } = await ctx.params;
  let body: { reason?: MessageReport["reason"]; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.reason || !VALID_REASONS.has(body.reason)) {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400 });
  }
  const r = reportMessage({
    conversation_id: id,
    message_id: msgId,
    reporter_id: auth.user.id,
    reason: body.reason,
    note: body.note ?? null,
  });
  if (!r.ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    { id: r.report.id, status: r.report.status },
    { status: 201 }
  );
}
