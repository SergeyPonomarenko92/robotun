/**
 * Module 8 — Feed service (MVP cut).
 *
 * Read-side ranking over active listings. Score formula computed inline
 * via SQL expression; cursor on (score, id). Filters: q (ILIKE-lite),
 * category_id, city.
 *
 * Out of scope: full Ukrainian FTS dictionary + GIN, generation-counter
 * Redis cache, promotions table, ts_rank_cd weight, admin NOT IN dedup.
 */
import { sql } from "../db/client.js";

type FeedItem = {
  id: string;
  title: string;
  cover_url: string | null;
  city: string | null;
  region: string | null;
  category_id: string;
  price_amount: number | null;
  price_amount_max: number | null;
  pricing_type: string;
  currency: string | null;
  provider_id: string | null;
  provider_name: string | null;
  provider_avatar_url: string | null;
  provider_kyc_approved: boolean;
  avg_rating: number | null;
  review_count: number;
  published_at: string;
  score: number;
  tags: string[];
};

export async function listFeed(opts: {
  q?: string;
  category_id?: string;
  city?: string;
  limit: number;
  cursor?: string;
}): Promise<{ items: FeedItem[]; next_cursor: string | null; has_more: boolean }> {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const params: unknown[] = [];

  const filters: string[] = [`l.status = 'active'`];
  if (opts.category_id) {
    params.push(opts.category_id);
    filters.push(`l.category_id = $${params.length}::uuid`);
  }
  if (opts.city) {
    params.push(opts.city);
    filters.push(`l.city = $${params.length}`);
  }
  let qIdx = 0;
  if (opts.q && opts.q.length >= 2) {
    const safe = opts.q.replace(/[\\%_]/g, (m) => "\\" + m);
    params.push(`%${safe}%`);
    qIdx = params.length;
    filters.push(`(l.title ILIKE $${qIdx} OR l.description ILIKE $${qIdx})`);
  }

  const qBoostExpr = qIdx > 0
    ? `CASE WHEN l.title ILIKE $${qIdx} THEN 20 ELSE 0 END`
    : `0`;

  const scoreExpr = `(
    100
    + COALESCE(rv.avg_rating, 0) * 10
    + LN(1 + COALESCE(dc.completed_count, 0)) * 20
    + CASE WHEN u.kyc_status = 'approved' THEN 30 ELSE 0 END
    + GREATEST(0, 60 - EXTRACT(EPOCH FROM (now() - l.published_at)) / 86400) * 0.5
    + ${qBoostExpr}
  )`;

  let cursorPredicate = "";
  if (opts.cursor) {
    try {
      const c = JSON.parse(Buffer.from(opts.cursor, "base64").toString("utf8")) as { s: number; i: string };
      params.push(c.s);
      const si = params.length;
      params.push(c.i);
      const ii = params.length;
      cursorPredicate = ` AND (${scoreExpr}, l.id::text) < ($${si}::float, $${ii}::text)`;
    } catch {}
  }

  const sqlText = `
    SELECT l.id, l.title, l.cover_url, l.city, l.region, l.category_id,
           l.price_amount, l.price_amount_max, l.pricing_type, l.currency,
           l.provider_id, l.published_at, l.tags,
           u.display_name AS provider_name, u.avatar_url AS provider_avatar_url,
           (u.kyc_status = 'approved') AS provider_kyc_approved,
           rv.avg_rating, COALESCE(rv.review_count, 0) AS review_count,
           ${scoreExpr} AS score
      FROM listings l
      LEFT JOIN users u ON u.id = l.provider_id
      LEFT JOIN LATERAL (
        SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS review_count
          FROM reviews
         WHERE reviewee_id = l.provider_id AND reviewer_role = 'client'
           AND status = 'published' AND revealed_at IS NOT NULL
      ) rv ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS completed_count
          FROM deals
         WHERE provider_id = l.provider_id AND status = 'completed'
      ) dc ON true
     WHERE ${filters.join(" AND ")}${cursorPredicate}
     ORDER BY score DESC, l.id DESC
     LIMIT ${limit + 1}
  `;

  const result = (await sql.unsafe(sqlText, params as never[])) as unknown as Array<{
    id: string;
    title: string;
    cover_url: string | null;
    city: string | null;
    region: string | null;
    category_id: string;
    price_amount: number | null;
    price_amount_max: number | null;
    pricing_type: string;
    currency: string | null;
    provider_id: string | null;
    provider_name: string | null;
    provider_avatar_url: string | null;
    provider_kyc_approved: boolean;
    avg_rating: number | null;
    review_count: number;
    published_at: Date | string;
    score: number;
    tags: string[];
  }>;

  const hasMore = result.length > limit;
  const slice = result.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ s: last.score, i: last.id }), "utf8").toString("base64")
    : null;

  return {
    items: slice.map((r) => ({
      ...r,
      published_at: typeof r.published_at === "string" ? r.published_at : r.published_at.toISOString(),
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}
