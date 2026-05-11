import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { listAdminActions } from "../../_mock/admin_audit";

/**
 * GET /api/v1/admin/audit?cursor&limit&target_user_id&action_prefix
 *
 * Module 12 §4 append-only admin_actions feed. Admin role gated.
 * Real backend reads from a partitioned table with admin_audit_search_index;
 * mock paginates the in-memory list.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20)
  );
  const cursor = url.searchParams.get("cursor");
  const target_user_id = url.searchParams.get("target_user_id");
  const action_prefix = url.searchParams.get("action_prefix");
  return NextResponse.json(
    listAdminActions({ limit, cursor, target_user_id, action_prefix })
  );
}
