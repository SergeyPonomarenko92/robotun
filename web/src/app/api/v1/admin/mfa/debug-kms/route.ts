import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { isKmsDegraded, setKmsDegraded } from "../../../_mock/mfa";

/**
 * POST /api/v1/admin/mfa/debug-kms — QA-ONLY toggle for the
 * `admin_kms_degraded` feature flag (Module 12 ADM-SEC-006). Mock-only.
 * Prod backend exposes the flag via ops tooling, not over the admin API.
 *
 * Body: { enabled: boolean }
 * Response: { kms_degraded: boolean }
 */
export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  setKmsDegraded(body.enabled);
  return NextResponse.json({ kms_degraded: isKmsDegraded() });
}

export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ kms_degraded: isKmsDegraded() });
}
