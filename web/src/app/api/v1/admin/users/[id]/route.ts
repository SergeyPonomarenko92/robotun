import { NextResponse } from "next/server";
import { authorize, store } from "../../../_mock/store";
import { balanceFor } from "../../../_mock/payments";
import { dealsStore } from "../../../_mock/deals";
import { listAdminActions } from "../../../_mock/admin_audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/admin/users/{id}
 *
 * Module 12 §4.8 user-detail snapshot. Mock returns a denormalized projection
 * combining user core + KYC + wallet (if provider) + deal counters + admin
 * action history. Real backend wraps this in a REPEATABLE READ TX so all the
 * sub-reads share a snapshot — out of scope for the mock.
 */
export async function GET(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const u = store.findUserById(id);
  if (!u) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const wallet = u.has_provider_role ? balanceFor(u.id) : null;
  // Deal counters (this user as either party).
  const asClientList = dealsStore.forUser(u.id, "client");
  const asProviderList = dealsStore.forUser(u.id, "provider");
  const asClient = asClientList.length;
  const asProvider = asProviderList.length;
  let active = 0;
  let disputed = 0;
  for (const d of [...asClientList, ...asProviderList]) {
    if (d.status === "active" || d.status === "in_review") active++;
    if (d.status === "disputed") disputed++;
  }
  // Admin actions targeting this user (denormalized in admin_actions row).
  const audit = listAdminActions({ target_user_id: u.id, limit: 20 });

  return NextResponse.json({
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    status: u.status,
    roles: u.roles,
    email_verified: u.email_verified,
    mfa_enrolled: u.mfa_enrolled,
    kyc_status: u.kyc_status,
    payout_enabled: u.payout_enabled,
    has_provider_role: u.has_provider_role,
    created_at: u.created_at,
    wallet: wallet
      ? {
          available_kopecks: wallet.available_kopecks,
          held_kopecks: wallet.held_kopecks,
          pending_payout_kopecks: wallet.pending_payout_kopecks,
        }
      : null,
    deal_counters: {
      as_client: asClient,
      as_provider: asProvider,
      active,
      disputed,
    },
    recent_admin_actions: audit.items,
  });
}
