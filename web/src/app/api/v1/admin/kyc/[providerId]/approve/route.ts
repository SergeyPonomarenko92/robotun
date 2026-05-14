import { NextResponse } from "next/server";
import { authorize, store } from "../../../../_mock/store";
import { approveApplication } from "../../../../_mock/kyc";
import { logAdminAction } from "../../../../_mock/admin_audit";

type Ctx = { params: Promise<{ providerId: string }> };

/**
 * POST /api/v1/admin/kyc/{providerId}/approve — REQ-007 + REQ-008.
 *
 * Atomic (mock) update of kyc_applications.status='approved' +
 * users.kyc_status='approved' + users.payout_enabled=mfa_enrolled (per §4.7
 * cross-table contract). Real backend does this inside a single DB tx with
 * an outbox emit; mock executes sequentially without rollback semantics.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const auth = authorize(_req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { providerId } = await ctx.params;
  const result = approveApplication(providerId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "not_found" ? 404 : 409 }
    );
  }
  const provider = store.findUserById(providerId);
  // §4.7: payout_enabled gated on mfa_enabled. Mock honors the same coupling.
  store.setUserKycStatus(
    providerId,
    "approved",
    provider?.mfa_enrolled ?? false
  );
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "kyc.approve",
    target_type: "user",
    target_id: providerId,
    target_user_id: providerId,
    metadata: { payout_enabled: provider?.mfa_enrolled ?? false },
  });
  return NextResponse.json({
    provider_id: providerId,
    status: result.app.status,
    payout_enabled: provider?.mfa_enrolled ?? false,
  });
}
