import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { dealsStore } from "../../_mock/deals";
import { listAllPayouts } from "../../_mock/payments";
import { countAdminActionsSince } from "../../_mock/admin_audit";

/**
 * GET /api/v1/admin/queue-counts — counts only, used by AdminShell tab bar.
 * Admin-role gated. Returns small JSON for ambient-awareness pips.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const disputes = dealsStore
    .forCaller(auth.user.id, true)
    .filter((d) => d.status === "disputed").length;
  const payouts = listAllPayouts().filter(
    (p) => p.status === "requested" || p.status === "processing"
  ).length;
  // audit pip = activity in last 24h (informational, not a backlog count).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const audit = countAdminActionsSince(since);
  return NextResponse.json({ disputes, payouts, audit });
}
