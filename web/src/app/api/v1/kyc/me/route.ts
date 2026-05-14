import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { getApplication } from "../../_mock/kyc";

/**
 * GET /api/v1/kyc/me — current provider's KYC snapshot.
 *
 * Returns `not_submitted` if no row exists yet so the wizard can render its
 * fresh-start state without first having to handle a 404. Provider-role gated.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.has_provider_role) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const app = getApplication(auth.user.id);
  if (!app) {
    return NextResponse.json({
      provider_id: auth.user.id,
      status: "not_submitted",
      submitted_at: null,
    });
  }
  return NextResponse.json({
    provider_id: app.provider_id,
    status: app.status,
    doc_type: app.doc_type,
    submitted_at: app.submitted_at,
    reviewed_at: app.reviewed_at,
    rejection_code: app.rejection_code,
  });
}
