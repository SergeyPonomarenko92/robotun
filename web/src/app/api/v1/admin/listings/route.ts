import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { listAllListingsForAdmin } from "../../_mock/listings";

/**
 * GET /api/v1/admin/listings — admin moderation queue.
 *
 * Filters:
 *   ?archived=true|false — restrict to archived (or non-archived) listings.
 *   ?q=<title fragment>   — case-insensitive substring on title + provider.
 *   ?limit=20            — capped to 100.
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
  const archivedParam = url.searchParams.get("archived");
  const q = url.searchParams.get("q")?.trim().toLowerCase();
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 20)
  );
  let rows = listAllListingsForAdmin();
  if (archivedParam === "true") rows = rows.filter((r) => r.archived);
  else if (archivedParam === "false") rows = rows.filter((r) => !r.archived);
  if (q) {
    rows = rows.filter((r) => {
      const hay =
        r.listing.title.toLowerCase() +
        " " +
        r.listing.provider.name.toLowerCase();
      return hay.includes(q);
    });
  }
  const items = rows.slice(0, limit).map((r) => ({
    id: r.listing.id,
    title: r.listing.title,
    cover_url: r.listing.cover_url,
    city: r.listing.city,
    category: r.listing.category,
    price_from_kopecks: r.listing.price_from_kopecks,
    price_unit: r.listing.price_unit,
    provider: {
      id: r.listing.provider.id,
      name: r.listing.provider.name,
      avatar_url: r.listing.provider.avatar_url,
      kyc_verified: r.listing.provider.kyc_verified,
    },
    archived: r.archived,
  }));
  return NextResponse.json({ items, total: rows.length });
}
