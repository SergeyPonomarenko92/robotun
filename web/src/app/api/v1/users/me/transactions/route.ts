import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { transactionsFor } from "../../../_mock/payments";

/**
 * GET /api/v1/users/me/transactions?limit&cursor
 *
 * Caller's wallet operations newest-first. base64url("{idx}") cursor.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") ?? 10) || 10)
  );
  const cursor = url.searchParams.get("cursor");
  return NextResponse.json(transactionsFor(auth.user.id, { limit, cursor }));
}
