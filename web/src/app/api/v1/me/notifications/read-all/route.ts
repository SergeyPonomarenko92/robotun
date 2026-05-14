import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { markAllRead } from "../../../_mock/notifications";

export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const n = markAllRead(auth.user.id);
  return NextResponse.json({ marked: n });
}
