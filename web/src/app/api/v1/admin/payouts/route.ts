import { NextResponse } from "next/server";
import { authorize, store } from "../../_mock/store";
import { listAllPayouts } from "../../_mock/payments";

/**
 * GET /api/v1/admin/payouts — Module 12 admin queue for payouts.
 * Admin-role gated. Embeds the payee display block for the table.
 */
export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.user.roles.includes("admin")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const items = listAllPayouts().map((p) => {
    const user = store.findUserById(p.user_id);
    return {
      ...p,
      payee: user
        ? {
            id: user.id,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
          }
        : { id: p.user_id, display_name: "Користувач" },
    };
  });
  return NextResponse.json({ items, total: items.length });
}
