import { NextResponse } from "next/server";
import { authorize, store } from "../../_mock/store";

/**
 * GET /api/v1/admin/users
 *
 * Module 12 §4.7 — admin user search. Mock supports:
 *   ?q=<email | display_name fragment>
 *   ?status=active|pending|suspended|deleted
 *   ?role=client|provider|admin
 *   ?limit=20 (default 20, max 100)
 *
 * Real backend uses /admin/users/search with weighted FTS; mock is plain
 * substring on email + display_name.
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
  const q = url.searchParams.get("q");
  const status = url.searchParams.get("status") as
    | "active"
    | "pending"
    | "suspended"
    | "deleted"
    | null;
  const role = url.searchParams.get("role") as
    | "client"
    | "provider"
    | "admin"
    | null;
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 20)
  );
  const items = store.listUsers({ q, status, role, limit }).map((u) => ({
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    status: u.status,
    roles: u.roles,
    kyc_status: u.kyc_status,
    created_at: u.created_at,
  }));
  return NextResponse.json({ items });
}
