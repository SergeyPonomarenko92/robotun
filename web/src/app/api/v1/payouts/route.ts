import { NextResponse } from "next/server";
import { authorize } from "../_mock/store";
import { requestPayout } from "../_mock/payments";

/**
 * POST /api/v1/payouts — provider requests a payout.
 *
 * Body: { amount_kopecks: integer }
 * KYC-gated per Module 4 + Module 11: caller must have kyc_status='approved'
 * AND payout_enabled=true. Errors:
 *   400 amount_invalid       — not a positive integer
 *   400 amount_below_min     — under 50 ₴
 *   409 insufficient_funds   — amount > wallet.available
 *   403 kyc_not_approved     — KYC not green
 *   403 payout_disabled      — payout_enabled flag is false
 *
 * Returns 201 with MockPayout on success.
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: { amount_kopecks?: number };
  try {
    body = (await req.json()) as { amount_kopecks?: number };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const amount = Number(body.amount_kopecks);
  const result = requestPayout(
    {
      id: auth.user.id,
      kyc_status: auth.user.kyc_status,
      payout_enabled: auth.user.payout_enabled,
    },
    amount
  );
  if ("error" in result) {
    const status =
      result.error === "kyc_not_approved" || result.error === "payout_disabled"
        ? 403
        : result.error === "insufficient_funds"
          ? 409
          : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result, { status: 201 });
}
