import { NextResponse } from "next/server";
import { authorize, store } from "../../../../_mock/store";
import { rejectApplication, REJECTION_CODES } from "../../../../_mock/kyc";
import { logAdminAction } from "../../../../_mock/admin_audit";

type Ctx = { params: Promise<{ providerId: string }> };

/**
 * POST /api/v1/admin/kyc/{providerId}/reject — REQ-007.
 *
 * Body: { rejection_code, rejection_note? }. rejection_code MUST be one of
 * the enum values (spec §4.1). Mock also nudges users.kyc_status='rejected'
 * + payout_enabled=false (defense-in-depth — provider can't accidentally
 * pull payouts after a rejection).
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { providerId } = await ctx.params;
  let body: { rejection_code?: string; rejection_note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const code = body.rejection_code ?? "";
  if (!(REJECTION_CODES as readonly string[]).includes(code)) {
    return NextResponse.json(
      { error: "invalid_rejection_code" },
      { status: 400 }
    );
  }
  const result = rejectApplication(providerId, code, body.rejection_note ?? null);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "not_found" ? 404 : 409 }
    );
  }
  store.setUserKycStatus(providerId, "rejected", false);
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "kyc.reject",
    target_type: "user",
    target_id: providerId,
    target_user_id: providerId,
    metadata: { rejection_code: code },
  });
  return NextResponse.json({
    provider_id: providerId,
    status: result.app.status,
    rejection_code: result.app.rejection_code,
  });
}
