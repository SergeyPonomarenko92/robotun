import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { createChallenge } from "../../../_mock/mfa";

/**
 * POST /api/v1/admin/mfa/challenge
 *
 * Issues a 6-digit MFA challenge bound to the admin caller. 5 min TTL,
 * single-use. Demo-only field `code` is returned so an operator without
 * an authenticator app can complete the flow — prod backend MUST NOT
 * return the code.
 *
 * Status mapping: 401 / 403 forbidden (non-admin).
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const challenge = createChallenge(auth.user.id);
  return NextResponse.json({
    id: challenge.id,
    expires_at: challenge.expires_at,
    // DEMO ONLY — real backend does NOT echo the code.
    code: challenge.code,
  });
}
