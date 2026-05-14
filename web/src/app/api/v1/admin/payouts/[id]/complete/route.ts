import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { completePayout } from "../../../../_mock/payments";
import { enqueueNotification } from "../../../../_mock/notifications";
import { consumeChallenge } from "../../../../_mock/mfa";
import { logAdminAction } from "../../../../_mock/admin_audit";

/**
 * POST /api/v1/admin/payouts/{id}/complete — Module 11 §4 PSP confirmation.
 *
 * Body: { mfa_challenge_id, mfa_code }
 * Admin-role gated + MFA challenge gated (Module 12 §SEC-006). Moves
 * pending_payout balance to zero and marks the payout 'paid'. Emits a
 * payout.completed audit row.
 *
 * Status mapping:
 *   401 unauthorized / 403 forbidden / 403 mfa_* / 404 not_found /
 *   409 already_paid (idempotency-safe).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;

  let body: { mfa_challenge_id?: string; mfa_code?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // MFA gate — same shape as dispute resolve.
  const mfa = consumeChallenge({
    adminId: auth.user.id,
    challengeId: body.mfa_challenge_id ?? null,
    code: body.mfa_code ?? null,
  });
  if ("error" in mfa) {
    return NextResponse.json({ error: mfa.error }, { status: 403 });
  }
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "mfa.challenge.consumed",
    target_type: "payout",
    target_id: id,
    metadata: { challenge_id: mfa.id, purpose: "payout.complete" },
  });

  const result = completePayout(id);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "payout.completed",
    target_type: "payout",
    target_id: result.id,
    target_user_id: result.user_id,
    metadata: {
      amount_kopecks: result.amount_kopecks,
      method_last4: result.method_last4,
    },
  });
  enqueueNotification({
    user_id: result.user_id,
    notification_code: "payout.completed",
    aggregate_type: "payout",
    aggregate_id: result.id,
    title: "Виплату зараховано",
    body: `Кошти ${(result.amount_kopecks / 100).toFixed(2)} ₴ на ${result.method_last4 ?? "вашу картку"}.`,
    href: "/provider-dashboard",
  });

  return NextResponse.json(result);
}
