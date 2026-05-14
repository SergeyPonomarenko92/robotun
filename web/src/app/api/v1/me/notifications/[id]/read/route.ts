import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { markRead } from "../../../../_mock/notifications";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const row = markRead(auth.user.id, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ id: row.id, read_at: row.read_at });
}
