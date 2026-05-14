import { NextResponse } from "next/server";
import { authorize, store } from "../../../../_mock/store";
import { consumeChallenge } from "../../../../_mock/mfa";
import { logAdminAction } from "../../../../_mock/admin_audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/admin/users/{id}/unsuspend — symmetric to /suspend.
 * Same MFA + admin gate; returns 409 if user is not currently suspended.
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
  if (target.status !== "suspended") {
    return NextResponse.json(
      { error: "not_suspended" },
      { status: 409 }
    );
  }
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

  const updated = store.setUserStatus(target.id, "active");
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "user.unsuspend",
    target_type: "user",
    target_id: target.id,
    target_user_id: target.id,
    metadata: { reason },
  });

  return NextResponse.json({
    id: updated!.id,
    status: updated!.status,
  });
}
