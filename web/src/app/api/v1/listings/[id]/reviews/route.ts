import { NextResponse } from "next/server";
import { findListing } from "../../../_mock/listings";
import { generateReviewsForListing } from "../../../_mock/reviews";

/**
 * GET /api/v1/listings/{id}/reviews?cursor&limit&rating
 *
 * Public endpoint per Module 7. Cursor on (created_at DESC, id) as the
 * spec requires; mock encodes "{idx}" base64url which is sufficient on
 * a stable deterministic generator.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const listing = findListing(id);
  if (!listing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") ?? 10) || 10)
  );
  const ratingParam = url.searchParams.get("rating");
  const ratingFilter =
    ratingParam && /^[1-5]$/.test(ratingParam) ? Number(ratingParam) : null;
  const cursor = url.searchParams.get("cursor");

  let pool = generateReviewsForListing(id);
  if (ratingFilter !== null) pool = pool.filter((r) => r.rating === ratingFilter);

  let startIdx = 0;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const n = Number.parseInt(decoded, 10);
      if (Number.isFinite(n) && n > 0 && n < pool.length) startIdx = n;
    } catch {
      // bad cursor -> from 0
    }
  }

  const slice = pool.slice(startIdx, startIdx + limit);
  const nextIdx = startIdx + limit;
  const next_cursor =
    nextIdx < pool.length
      ? Buffer.from(String(nextIdx), "utf8").toString("base64url")
      : null;

  return NextResponse.json({
    items: slice,
    next_cursor,
    total: pool.length,
  });
}
