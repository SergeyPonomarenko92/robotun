import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { dealsStore, projectDeal, type DealStatus } from "../../../_mock/deals";

const VALID_STATUSES: DealStatus[] = [
  "pending",
  "active",
  "in_review",
  "completed",
  "disputed",
  "cancelled",
];

const VALID_ROLES = new Set<"client" | "provider" | "any">([
  "client",
  "provider",
  "any",
]);

/**
 * GET /api/v1/users/me/deals
 *
 * Query params:
 *   role?    = client | provider | any (default: any)
 *   status?  = comma-separated DealStatus list (default: all)
 *   limit?   = 1..50 (default 20)
 *   cursor?  = opaque "created_at|id" (descending by created_at)
 *
 * Returns:
 *   { items: DealProjection[], next_cursor: string | null, total: number }
 *
 * Real backend would page via a true keyset on (created_at desc, id desc)
 * with users.deals_count denorm; mock uses in-memory slice.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const roleParam = (url.searchParams.get("role") ?? "any") as
    | "client"
    | "provider"
    | "any";
  if (!VALID_ROLES.has(roleParam)) {
    return NextResponse.json(
      { error: "invalid_role" },
      { status: 400 }
    );
  }
  const statusParam = url.searchParams.get("status");
  const statusFilter: DealStatus[] | null = statusParam
    ? (statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.includes(s as DealStatus)) as DealStatus[])
    : null;
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20)
  );
  const cursor = url.searchParams.get("cursor");

  const demoActAsProvider =
    auth.user.email === "provider@robotun.dev" && roleParam !== "client";

  let pool = dealsStore.forCaller(auth.user.id, demoActAsProvider);

  if (roleParam === "client") {
    pool = pool.filter((d) => d.client_id === auth.user.id);
  } else if (roleParam === "provider" && !demoActAsProvider) {
    pool = pool.filter((d) => d.provider_id === auth.user.id);
  }
  if (statusFilter && statusFilter.length > 0) {
    pool = pool.filter((d) => statusFilter.includes(d.status));
  }

  const total = pool.length;

  let startIdx = 0;
  if (cursor) {
    try {
      const [ts, id] = Buffer.from(cursor, "base64url")
        .toString("utf8")
        .split("|");
      const found = pool.findIndex(
        (d) => d.created_at === ts && d.id === id
      );
      if (found >= 0) startIdx = found + 1;
    } catch {
      // Bad cursor — start from 0.
    }
  }

  const slice = pool.slice(startIdx, startIdx + limit);
  const last = slice[slice.length - 1];
  const next_cursor =
    slice.length === limit && startIdx + limit < pool.length && last
      ? Buffer.from(`${last.created_at}|${last.id}`, "utf8").toString(
          "base64url"
        )
      : null;

  return NextResponse.json({
    items: slice.map(projectDeal),
    next_cursor,
    total,
  });
}
