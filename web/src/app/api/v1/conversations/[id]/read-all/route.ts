import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { markAllRead } from "../../../_mock/messaging";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/conversations/{id}/read-all — bulk-mark all messages in this
 * conversation as read for the caller. REQ-010: read marks live separately
 * (mock keeps them in-memory, Redis in production).
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const ok = markAllRead(auth.user.id, id);
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
