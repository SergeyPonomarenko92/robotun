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

type FeedResult =
  | { ok: true; items: FeedItem[]; next_cursor: string | null; has_more: boolean }
  | { ok: false; error: { code: string; status: number } };

export async function listFeed(opts: {
  q?: string;
  category_id?: string;
  city?: string;
  limit: number;
  cursor?: string;
}): Promise<FeedResult> {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const params: unknown[] = [];

  // as_of snapshots `now()` for the score formula so subsequent page reads
  // compare against the SAME recency baseline used to encode the cursor.
  // Without this, the time-dependent term drifts every second and the
  // (score, id) keyset can drop or repeat boundary rows.
  let asOf: Date;
  let cursorObj: { s: number; i: string; t: string } | null = null;
  if (opts.cursor) {
    try {
      const o = JSON.parse(Buffer.from(opts.cursor, "base64").toString("utf8"));
      if (typeof o?.s === "number" && typeof o?.i === "string" && typeof o?.t === "string" && !isNaN(Date.parse(o.t))) {
        cursorObj = o;
      }
    } catch {}
    if (!cursorObj) return { ok: false, error: { code: "invalid_cursor", status: 400 } };
    asOf = new Date(cursorObj.t);
  } else {
    asOf = new Date();
  }
  params.push(asOf);
  const asOfIdx = params.length;

  const filters: string[] = [`l.status = 'active'`, `u.status = 'active'`];
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
    // q-search scoped to title only (description ILIKE on free-text would
    // need a trigram GIN index, deferred). Use explicit ESCAPE for clarity.
    filters.push(`l.title ILIKE $${qIdx} ESCAPE '\\'`);
  }

  const qBoostExpr = qIdx > 0
    ? `CASE WHEN l.title ILIKE $${qIdx} ESCAPE '\\' THEN 20 ELSE 0 END`
    : `0`;

  // Score formula uses $asOf snapshot, NOT now(), so cursor pagination is
  // stable across requests.
  const scoreExpr = `(
    100
    + COALESCE(rv.avg_rating, 0) * 10
    + LN(1 + COALESCE(dc.completed_count, 0)) * 20
    + CASE WHEN u.kyc_status = 'approved' THEN 30 ELSE 0 END
    + GREATEST(0, 60 - EXTRACT(EPOCH FROM ($${asOfIdx}::timestamptz - l.published_at)) / 86400) * 0.5
    + ${qBoostExpr}
  )`;

  let cursorPredicate = "";
  if (cursorObj) {
    params.push(cursorObj.s);
    const si = params.length;
    params.push(cursorObj.i);
    const ii = params.length;
    cursorPredicate = ` AND (${scoreExpr}, l.id::text) < ($${si}::float, $${ii}::text)`;
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
  // Carry asOf forward in the cursor so the next page uses the same baseline.
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ s: last.score, i: last.id, t: asOf.toISOString() }), "utf8").toString("base64")
    : null;

  return {
    ok: true,
    items: slice.map((r) => ({
      ...r,
      published_at: typeof r.published_at === "string" ? r.published_at : r.published_at.toISOString(),
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}
