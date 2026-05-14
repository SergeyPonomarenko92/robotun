import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { unreadCountForUser } from "../../../_mock/notifications";

export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  return NextResponse.json({ count: unreadCountForUser(auth.user.id) });
}
