import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import {
  createChallenge,
  isKmsDegraded,
  checkAndConsumeIssueRate,
} from "../../../_mock/mfa";
import { logAdminAction } from "../../../_mock/admin_audit";

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
  // ADM-SEC-006: KMS-degraded → 503 admin_mfa_unavailable + Retry-After: 60.
  if (isKmsDegraded()) {
    return NextResponse.json(
      { error: "admin_mfa_unavailable" },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  // Per-admin rate limit (5/min). 429 with Retry-After tells the client when
  // the next issuance will be allowed.
  const rate = checkAndConsumeIssueRate(auth.user.id);
  if (!rate.ok) {
    return NextResponse.json(
      {
        error: "mfa_challenge_rate_limited",
        retry_after_seconds: rate.retry_after_seconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retry_after_seconds) },
      }
    );
  }
  const challenge = createChallenge(auth.user.id);
  logAdminAction({
    actor_admin_id: auth.user.id,
    action: "mfa.challenge.issued",
    metadata: { challenge_id: challenge.id, expires_at: challenge.expires_at },
  });
  return NextResponse.json({
    id: challenge.id,
    expires_at: challenge.expires_at,
    // DEMO ONLY — real backend does NOT echo the code.
    code: challenge.code,
  });
}
