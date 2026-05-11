import { NextResponse } from "next/server";
import { authorize } from "../../../../_mock/store";
import { resolveDispute, projectDeal } from "../../../../_mock/deals";

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

  let body: { verdict?: string; reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

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
  return NextResponse.json(projectDeal(result.deal));
}
