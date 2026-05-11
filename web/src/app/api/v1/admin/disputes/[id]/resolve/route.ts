import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { resolveDispute, projectDeal } from "../../../../_mock/deals";
import { consumeChallenge } from "../../../../_mock/mfa";
import { logAdminAction } from "../../../../_mock/admin_audit";

/**
 * POST /api/v1/admin/disputes/{id}/resolve — Module 14 §4 verdict.
 *
 * Body: { verdict: 'refund_client'|'release_to_provider', reason: string (≥10) }
 * Admin role required. Spec §10 requires MFA challenge for resolutions;
 * mock skips MFA but flags it inline so the wiring can be added later.
 *
 * Status mapping:
 *   400 validation_failed.fields
 *   401 unauthorized / 403 forbidden / 404 not_found
 *   409 invalid_state (status != 'disputed')
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

  let body: {
    verdict?: string;
    reason?: string;
    mfa_challenge_id?: string;
    mfa_code?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Module 12 §SEC-006 MFA gate.
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
    target_type: "deal",
    target_id: id,
    metadata: { challenge_id: mfa.id, purpose: "dispute.resolve" },
  });

  const result = resolveDispute(id, auth.user.id, {
    verdict: body.verdict ?? "",
    reason: body.reason ?? "",
  });
  if ("error" in result) {
    if (result.error === "validation_failed") {
      return NextResponse.json(
        { error: "validation_failed", fields: result.fields },
        { status: 400 }
      );
    }
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "forbidden"
          ? 403
          : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  // Module 12 §4 — append-only audit row for the resolution itself.
  // target_user_id denormalizes the affected party (favoured side) so the
  // support-role timeline filter can find this row without a JOIN.
  const favoured =
    body.verdict === "release_to_provider"
      ? result.deal.provider_id
      : result.deal.client_id;
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "dispute.resolved",
    target_type: "deal",
    target_id: result.deal.id,
    target_user_id: favoured,
    metadata: {
      verdict: result.deal.dispute_resolution?.verdict ?? null,
      reason: result.deal.dispute_resolution?.reason ?? null,
      budget_kopecks: result.deal.budget_kopecks,
    },
  });
  return NextResponse.json(projectDeal(result.deal));
}
