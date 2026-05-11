import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { submitDisputeEvidence, projectDeal } from "../../../_mock/deals";

/**
 * POST /api/v1/deals/{id}/dispute-evidence — Module 14 §4.
 *
 * Body: { reason: DisputeReason, statement: 30..4000, attachment_ids?: 0..5 }
 * One-shot per party. Status mapping:
 *   400 validation_failed.fields
 *   401 unauthorized
 *   403 forbidden
 *   404 not_found
 *   409 invalid_state (status != 'disputed')
 *   409 already_submitted
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;

  let body: { reason?: string; statement?: string; attachment_ids?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const demoActAsProvider = auth.user.email === "provider@robotun.dev";
  const result = submitDisputeEvidence(
    id,
    auth.user.id,
    {
      reason: body.reason ?? "",
      statement: body.statement ?? "",
      attachment_ids: body.attachment_ids,
    },
    demoActAsProvider
  );
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
