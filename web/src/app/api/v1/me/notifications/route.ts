import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { listForUser } from "../../_mock/notifications";

export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit")) || undefined;
  const r = listForUser({ user_id: auth.user.id, cursor, limit });
  return NextResponse.json(r);
}
