import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { balanceFor } from "../../../_mock/payments";

/**
 * GET /api/v1/users/me/wallet
 *
 * Returns the caller's provider-side balance buckets. Real backend reads
 * from materialized account balances with strict invariants per Module 11;
 * mock derives by summing the ledger.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  return NextResponse.json(balanceFor(auth.user.id));
}
