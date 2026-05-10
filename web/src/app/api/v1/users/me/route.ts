import { NextResponse } from "next/server";
import { authorize, projectUser } from "../../_mock/store";

export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  return NextResponse.json(projectUser(auth.user));
}
