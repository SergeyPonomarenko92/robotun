import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import {
  blockConversation,
  findConversation,
  isParty,
  unblockConversation,
} from "../../../_mock/messaging";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const c = findConversation(id);
  if (!c || !isParty(c, auth.user.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ok = blockConversation(id, auth.user.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ id, blocked: true, blocked_by: auth.user.id });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const c = findConversation(id);
  if (!c || !isParty(c, auth.user.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ok = unblockConversation(id, auth.user.id);
  if (!ok) {
    // Either no block existed, or caller isn't the blocker. Distinct codes
    // help the UI ("спочатку відновіть бесіду — її заблокував контрагент")
    // vs "no-op already-unblocked".
    return NextResponse.json(
      { error: "cannot_unblock" },
      { status: 409 }
    );
  }
  return NextResponse.json({ id, blocked: false });
}
