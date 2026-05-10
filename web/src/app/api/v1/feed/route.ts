import { NextResponse } from "next/server";
import {
  decodeCursor,
  encodeCursor,
  listAllListings,
  type ListingProjection,
} from "../_mock/listings";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

function applyFilters(
  items: ListingProjection[],
  params: URLSearchParams
): ListingProjection[] {
  const categoryId = params.get("category_id");
  const city = params.get("city");
  const priceMin = params.get("price_min");
  const priceMax = params.get("price_max");
  const minRating = params.get("min_rating");
  const kycOnly = params.get("kyc_only");
  const q = params.get("q")?.trim().toLowerCase();

  return items.filter((l) => {
    if (categoryId && l.category_id !== categoryId) return false;
    if (city && l.city !== city) return false;
    if (priceMin && l.price_from_kopecks < Number(priceMin)) return false;
    if (priceMax && l.price_from_kopecks > Number(priceMax)) return false;
    if (minRating && l.provider.avg_rating < Number(minRating)) return false;
    if (kycOnly === "true" && !l.provider.kyc_verified) return false;
    if (q) {
      const hay =
        l.title.toLowerCase() +
        " " +
        l.category.toLowerCase() +
        " " +
        l.city.toLowerCase() +
        " " +
        l.provider.name.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(params.get("limit")) || DEFAULT_LIMIT)
  );

  // Module 8 REQ-002: keyset (score DESC, id DESC). Sort once, paginate via cursor.
  const all = listAllListings()
    .slice()
    .sort((a, b) => {
      if (b.feed_base_score !== a.feed_base_score)
        return b.feed_base_score - a.feed_base_score;
      return b.id.localeCompare(a.id);
    });

  const filtered = applyFilters(all, params);
  const totalEstimate = filtered.length;

  let startIdx = 0;
  const cursorParam = params.get("cursor");
  if (cursorParam) {
    const c = decodeCursor(cursorParam);
    if (!c) {
      return NextResponse.json(
        { error: "invalid_cursor" },
        { status: 400 }
      );
    }
    // Find the first row strictly AFTER (score, id) per keyset semantics
    startIdx = filtered.findIndex(
      (l) =>
        l.feed_base_score < c.score ||
        (l.feed_base_score === c.score && l.id.localeCompare(c.id) < 0)
    );
    if (startIdx < 0) startIdx = filtered.length;
  }

  const slice = filtered.slice(startIdx, startIdx + limit);
  const last = slice[slice.length - 1];
  const hasMore = startIdx + limit < filtered.length;
  const nextCursor =
    hasMore && last
      ? encodeCursor({ score: last.feed_base_score, id: last.id, v: 1 })
      : null;

  return NextResponse.json({
    items: slice,
    next_cursor: nextCursor,
    total_estimate: totalEstimate,
  });
}
