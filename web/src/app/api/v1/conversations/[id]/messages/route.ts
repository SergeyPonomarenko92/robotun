import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { listMessages, sendMessage } from "../../../_mock/messaging";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit")) || undefined;
  const r = listMessages({
    conversation_id: id,
    caller_user_id: auth.user.id,
    cursor,
    limit,
  });
  if (!r.ok) {
    // not_party and not_found both → 404 (IDOR guard).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(r.data);
}

export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  let body: { body?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const r = sendMessage({
    conversation_id: id,
    sender_id: auth.user.id,
    body: body.body ?? "",
  });
  if (!r.ok) {
    if (r.error === "not_party") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (r.error === "conversation_locked") {
      return NextResponse.json({ error: r.error }, { status: 409 });
    }
    return NextResponse.json({ error: r.error }, { status: 400 });
  }
  return NextResponse.json(r.message, { status: 201 });
}
