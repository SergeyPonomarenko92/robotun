import { NextResponse } from "next/server";
import { authorize, store } from "../../_mock/store";
import {
  listApplicationsByStatus,
  type KycStatus,
} from "../../_mock/kyc";

/**
 * GET /api/v1/admin/kyc — Module 4 spec p.510 queue.
 *
 * Filters:
 *   ?status=submitted|in_review|approved|rejected|open (default 'open' =
 *   submitted∪in_review). Joined with users table for display fields.
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
  const status = (url.searchParams.get("status") ?? "open") as
    | KycStatus
    | "open";
  const apps = listApplicationsByStatus(status);
  const items = apps.map((a) => {
    const u = store.findUserById(a.provider_id);
    return {
      provider_id: a.provider_id,
      provider: u
        ? {
            id: u.id,
            display_name: u.display_name,
            email: u.email,
            avatar_url: u.avatar_url,
          }
        : null,
      status: a.status,
      doc_type: a.doc_type,
      legal_name: a.legal_name,
      tax_id: a.tax_id,
      submitted_at: a.submitted_at,
      reviewed_at: a.reviewed_at,
      rejection_code: a.rejection_code,
    };
  });
  return NextResponse.json({ items });
}
