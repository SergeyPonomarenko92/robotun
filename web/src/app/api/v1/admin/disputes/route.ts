import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { dealsStore, projectDeal } from "../../_mock/deals";

/**
 * GET /api/v1/admin/disputes — Module 14 §4 admin queue.
 * Returns all deals currently in 'disputed' status, newest first.
 * Admin role required (Module 12 RBAC). 403 otherwise.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // All disputed deals across the store.
  const all = dealsStore
    .forCaller(auth.user.id, true /* widen to all */)
    .filter((d) => d.status === "disputed");

  return NextResponse.json({
    items: all.map(projectDeal),
    total: all.length,
  });
}
