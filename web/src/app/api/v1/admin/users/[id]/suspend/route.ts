import { NextResponse } from "next/server";
import { authorize, store } from "../../../../_mock/store";
import { consumeChallenge } from "../../../../_mock/mfa";
import { logAdminAction } from "../../../../_mock/admin_audit";
import { enqueueNotification } from "../../../../_mock/notifications";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/admin/users/{id}/suspend — Module 12 §4.7 + ADM-SEC-006.
 *
 * Body: { reason: string; mfa_challenge_id: string; mfa_code: string }.
 * Flow:
 *   1. JWT + role re-read (admin only) per ADM-SEC-001.
 *   2. Consume MFA challenge (admin-bound, single-use).
 *   3. setUserStatus('suspended') — bumps ver to invalidate access tokens
 *      (real Auth would also revoke refresh sessions; mock just flips ver).
 *   4. Append admin_actions row (target_user_id denormalized).
 *
 * Idempotent: suspending an already-suspended user returns 409.
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (id === auth.user.id) {
    return NextResponse.json(
      { error: "cannot_suspend_self" },
      { status: 422 }
    );
  }
  let body: { reason?: string; mfa_challenge_id?: string; mfa_code?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const reason = (body.reason ?? "").trim();
  if (reason.length < 10) {
    return NextResponse.json(
      { error: "reason_too_short" },
      { status: 400 }
    );
  }
  const target = store.findUserById(id);
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (target.status === "suspended") {
    return NextResponse.json(
      { error: "already_suspended" },
      { status: 409 }
    );
  }
  if (target.status === "deleted") {
    return NextResponse.json({ error: "user_deleted" }, { status: 409 });
  }
  // Consume MFA challenge.
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
    target_user_id: target.id,
    metadata: { challenge_id: mfa.id },
  });

  const updated = store.setUserStatus(target.id, "suspended");
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "user.suspend",
    target_type: "user",
    target_id: target.id,
    target_user_id: target.id,
    metadata: { reason },
  });
  enqueueNotification({
    user_id: target.id,
    notification_code: "user.suspended",
    aggregate_type: "user",
    aggregate_id: target.id,
    title: "Обліковий запис зупинено",
    body: "Доступ обмежено модератором. Зверніться у підтримку для деталей.",
    href: "/",
    mandatory: true,
  });

  return NextResponse.json({
    id: updated!.id,
    status: updated!.status,
  });
}
