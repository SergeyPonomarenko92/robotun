/**
 * Module 7 — Reviews service (MVP cut).
 *
 * IN SCOPE: post-deal review by both sides (one per role per deal), reply,
 * provider/listing aggregates, listing-public feed.
 *
 * OUT OF SCOPE (TODO): blind-double-review reveal mechanism (we publish+
 * reveal immediately on submit), 14d reveal sweep cron, review_reports
 * moderation queue, RLS (app-level filter), aggregate denorm columns,
 * GDPR erasure of reviewer_id/comment.
 */
import { and, desc, eq, inArray, isNotNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  deals,
  listings,
  outboxEvents,
  reviewReplies,
  reviews,
} from "../db/schema.js";

// Module 7 REQ-004 — eligible_until = eligible_from + 90 days. Earlier
// MVP cut used 60d; spec amended to 90 (the §3.1 REQ-007 60d in Module
// "marketplace social platform" referred to leaving a review at all,
// while the Reviews-module spec gives the canonical window length).
const REVIEW_WINDOW_DAYS = 90;

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

function pgCode(e: unknown): string | undefined {
  const o = e as { code?: string; cause?: { code?: string } };
  return o?.code ?? o?.cause?.code;
}

/* ------------------------------- CREATE ---------------------------------- */

export type CreateInput = {
  reviewer_id: string;
  deal_id: string;
  overall_rating: number;
  quality_rating?: number | null;
  communication_rating?: number | null;
  timeliness_rating?: number | null;
  comment?: string | null;
};

export async function createReview(input: CreateInput): Promise<Result<{ id: string; reviewer_role: "client" | "provider" }>> {
  if (input.overall_rating < 1 || input.overall_rating > 5) {
    return err("validation_failed", 400, { fields: { overall_rating: "range_1_5" } });
  }
  if (input.comment != null && (input.comment.length < 20 || input.comment.length > 2000)) {
    return err("validation_failed", 400, { fields: { comment: "length_20_2000" } });
  }

  return await db.transaction(async (tx) => {
    // FOR UPDATE on the deal row serializes the two concurrent submits
    // (client + provider). Without the lock the trg_set_both_submitted
    // trigger sees the counterparty's still-uncommitted row in only one
    // of the two transactions and `both_submitted` drifts. Both rows now
    // observe the other after the second one commits, so the trigger sets
    // both flags correctly on the second insert. MVP immediate-reveal
    // makes this latent today; v2 blind-reveal would surface the drift.
    const dlock = await tx.execute<{ id: string }>(
      dsql`SELECT id FROM deals WHERE id = ${input.deal_id} FOR UPDATE`
    );
    if (dlock.length === 0) return err("deal_not_found", 404);
    const dr = await tx
      .select()
      .from(deals)
      .where(eq(deals.id, input.deal_id))
      .limit(1);
    if (dr.length === 0) return err("deal_not_found", 404);
    const d = dr[0]!;

    const isClient = d.client_id === input.reviewer_id;
    const isProvider = d.provider_id === input.reviewer_id;
    // Spec §4.9: "not a deal participant" and "deal not in terminal review
    // state" collapse to the same 403 deal_not_eligible code. Avoids leaking
    // whether a non-participant guessed a real deal id.
    if (!isClient && !isProvider) {
      return err("deal_not_eligible", 403, { reason: "not_a_party" });
    }

    // Reviews only on terminal completed/disputed/cancelled deals — but spec
    // is "after completion". MVP: require status='completed'. Drop disputed
    // path until Module 14 is wired.
    if (d.status !== "completed") {
      return err("deal_not_eligible", 403, { current_status: d.status });
    }

    // Window: 60d after completion. Anchored on deals.completed_at — written
    // once at status flip in approveDeal / cron auto-complete / dispute
    // resolveDispute. Fallback to updated_at for legacy rows that completed
    // before migration 0016 backfilled completed_at from updated_at; new
    // completions ignore the fallback path.
    const anchor = d.completed_at ?? d.updated_at;
    const windowEnd = new Date(anchor.getTime() + REVIEW_WINDOW_DAYS * 24 * 3600 * 1000);
    if (Date.now() > windowEnd.getTime()) {
      // Spec §4.9 — window-closed is a sub-case of deal_not_eligible (403).
      // Distinct error code kept so FE error UX can render the specific
      // "review window has closed" message.
      return err("review_window_closed", 403, { window_until: windowEnd.toISOString() });
    }

    const role: "client" | "provider" = isClient ? "client" : "provider";
    const revieweeId = isClient ? d.provider_id : d.client_id;

    // Role-shape validation: client must supply 4 subscores; provider only overall.
    if (role === "client") {
      const q = input.quality_rating, c = input.communication_rating, t = input.timeliness_rating;
      if (q == null || c == null || t == null) {
        return err("validation_failed", 400, {
          fields: {
            quality_rating: q == null ? "required" : undefined,
            communication_rating: c == null ? "required" : undefined,
            timeliness_rating: t == null ? "required" : undefined,
          },
        });
      }
      for (const [k, v] of Object.entries({ quality_rating: q, communication_rating: c, timeliness_rating: t })) {
        if (v < 1 || v > 5) return err("validation_failed", 400, { fields: { [k]: "range_1_5" } });
      }
    } else {
      if (input.quality_rating != null || input.communication_rating != null || input.timeliness_rating != null) {
        return err("validation_failed", 400, { fields: { subscores: "provider_role_forbids_subscores" } });
      }
    }

    const now = new Date();
    const inserted = await tx
      .insert(reviews)
      .values({
        deal_id: input.deal_id,
        listing_id: d.listing_id,
        reviewer_id: input.reviewer_id,
        reviewee_id: revieweeId,
        reviewer_role: role,
        overall_rating: input.overall_rating,
        quality_rating: role === "client" ? input.quality_rating ?? null : null,
        communication_rating: role === "client" ? input.communication_rating ?? null : null,
        timeliness_rating: role === "client" ? input.timeliness_rating ?? null : null,
        comment: input.comment ?? null,
        status: "published",
        submitted_at: now,
        // MVP: immediate reveal. v2 blind-reveal will gate on both_submitted
        // or REVIEW_WINDOW_DAYS sweep.
        revealed_at: now,
      })
      .returning({ id: reviews.id });
    const rid = inserted[0]!.id;

    await tx.insert(outboxEvents).values({
      aggregate_type: "review",
      aggregate_id: rid,
      event_type: "review.submitted",
      payload: {
        review_id: rid,
        deal_id: input.deal_id,
        reviewer_id: input.reviewer_id,
        reviewee_id: revieweeId,
        reviewer_role: role,
        overall_rating: input.overall_rating,
      },
    });

    return { ok: true as const, value: { id: rid, reviewer_role: role } };
  }).catch((e) => {
    // Spec §4.9 canonical code is `already_reviewed`.
    if (pgCode(e) === "23505") return err("already_reviewed", 409);
    throw e;
  });
}

/* ------------------------------- REPLY ---------------------------------- */

export async function createReply(args: {
  user_id: string;
  review_id: string;
  body: string;
}): Promise<Result<{ id: string }>> {
  if (args.body.length < 1 || args.body.length > 2000) {
    return err("validation_failed", 400, { fields: { body: "length_1_2000" } });
  }

  return await db.transaction(async (tx) => {
    const r = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.id, args.review_id))
      .limit(1);
    if (r.length === 0) return err("review_not_found", 404);
    const rev = r[0]!;
    // Only the reviewee can reply.
    if (rev.reviewee_id !== args.user_id) return err("forbidden", 403);
    if (rev.status !== "published" || !rev.revealed_at) {
      return err("review_not_revealed", 409);
    }

    const inserted = await tx
      .insert(reviewReplies)
      .values({ review_id: args.review_id, author_id: args.user_id, body: args.body })
      .returning({ id: reviewReplies.id });
    const id = inserted[0]!.id;

    await tx.insert(outboxEvents).values({
      aggregate_type: "review",
      aggregate_id: args.review_id,
      event_type: "review.replied",
      payload: { review_id: args.review_id, reply_id: id, author_id: args.user_id },
    });

    return { ok: true as const, value: { id } };
  }).catch((e) => {
    const ec = pgCode(e);
    if (ec === "23505") return err("reply_already_exists", 409);
    if (ec === "P0001") return err("review_not_revealed", 409);
    throw e;
  });
}

/* -------------------------------- READS --------------------------------- */

/**
 * FE shape (web/src/lib/reviews.ts:5):
 *   { id, rating, body, created_at, author: {display_name, avatar_url?},
 *     deal_ref?, reply?, status }
 *
 * Internal fields (overall_rating, quality_rating, reviewee_id,
 * reviewer_role, etc.) are still in the row but not surfaced here —
 * admin/own views fetch them via a separate projection if needed.
 */
type PublicReview = {
  id: string;
  rating: number;
  body: string | null;
  created_at: string;
  author: { display_name: string; avatar_url?: string };
  deal_ref?: string;
  reply?: { body: string; created_at: string };
  status: "published";
};

async function projectReviews(
  rows: { id: string }[],
  opts: { includeDealRef?: boolean } = {}
): Promise<PublicReview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Hidden replies (status='hidden') must NOT appear in public feeds — a
  // moderator hiding a reply for harassment/defamation expects it gone.
  // CHECK constraint allows ('published','hidden'); JOIN predicate enforces.
  const fullRows = await db.execute<{
    id: string;
    overall_rating: number;
    comment: string | null;
    deal_id: string;
    created_at: string;
    revealed_at: string | null;
    reviewer_name: string | null;
    reviewer_avatar: string | null;
    reply_body: string | null;
    reply_created_at: string | null;
  }>(
    dsql`SELECT r.id, r.overall_rating, r.comment, r.deal_id,
                r.created_at, r.revealed_at,
                u.display_name AS reviewer_name, u.avatar_url AS reviewer_avatar,
                rep.body AS reply_body, rep.created_at AS reply_created_at
           FROM reviews r
           LEFT JOIN users u ON u.id = r.reviewer_id
           LEFT JOIN review_replies rep ON rep.review_id = r.id AND rep.status = 'published'
          WHERE r.id = ANY(${ids}::uuid[])`
  );
  // Preserve incoming ids order.
  const byId = new Map(fullRows.map((r) => [r.id, r]));
  return rows
    .map((row) => byId.get(row.id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({
      id: r.id,
      rating: r.overall_rating,
      body: r.comment,
      created_at: new Date(r.revealed_at ?? r.created_at).toISOString(),
      author: {
        display_name: r.reviewer_name ?? "Видалений користувач",
        avatar_url: r.reviewer_avatar ?? undefined,
      },
      // deal_ref exposes raw deal UUID. Public listing/user feeds are
      // unauthenticated — emitting it builds a listing→deal_ids oracle. Only
      // /deals/:id/reviews (viewer is already proven to be a party) sets
      // includeDealRef=true.
      ...(opts.includeDealRef ? { deal_ref: r.deal_id } : {}),
      reply: r.reply_body
        ? {
            body: r.reply_body,
            created_at: new Date(r.reply_created_at!).toISOString(),
          }
        : undefined,
      status: "published" as const,
    }));
}

function decodeReviewCursor(c: string | undefined): { t: string; i: string } | null {
  if (!c) return null;
  try {
    const o = JSON.parse(Buffer.from(c, "base64").toString("utf8")) as Partial<{ t: string; i: string }>;
    if (typeof o?.t !== "string" || typeof o?.i !== "string") return null;
    // Bad timestamps used to drop the comparison to NULL → empty page silently.
    if (Number.isNaN(new Date(o.t).getTime())) return null;
    // Bad UUIDs used to bubble up as a 500 from PG cast.
    if (!/^[0-9a-f-]{36}$/i.test(o.i)) return null;
    return { t: o.t, i: o.i };
  } catch {
    return null;
  }
}

export async function listForListing(
  listingId: string,
  opts: { limit: number; cursor?: string; rating?: number }
) {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const baseWhere = [
    eq(reviews.listing_id, listingId),
    eq(reviews.status, "published"),
    eq(reviews.reviewer_role, "client"),
    isNotNull(reviews.revealed_at),
  ];
  if (opts.rating && opts.rating >= 1 && opts.rating <= 5) {
    baseWhere.push(eq(reviews.overall_rating, opts.rating));
  }
  const where = [...baseWhere];
  const cur = decodeReviewCursor(opts.cursor);
  if (cur) {
    where.push(dsql`(${reviews.revealed_at}, ${reviews.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`);
  }
  const r = await db
    .select({ id: reviews.id, revealed_at: reviews.revealed_at })
    .from(reviews)
    .where(and(...where))
    .orderBy(desc(reviews.revealed_at), desc(reviews.id))
    .limit(limit + 1);
  const hasMore = r.length > limit;
  const slice = r.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last?.revealed_at
    ? Buffer.from(JSON.stringify({ t: last.revealed_at.toISOString(), i: last.id }), "utf8").toString("base64")
    : null;
  // Total ignores cursor but honors rating filter.
  const totalRows = await (opts.rating && opts.rating >= 1 && opts.rating <= 5
    ? db.execute<{ n: number }>(
        dsql`SELECT COUNT(*)::int AS n FROM reviews
              WHERE listing_id = ${listingId}
                AND status = 'published' AND reviewer_role='client' AND revealed_at IS NOT NULL
                AND overall_rating = ${opts.rating}`
      )
    : db.execute<{ n: number }>(
        dsql`SELECT COUNT(*)::int AS n FROM reviews
              WHERE listing_id = ${listingId}
                AND status = 'published' AND reviewer_role='client' AND revealed_at IS NOT NULL`
      ));
  return {
    items: await projectReviews(slice),
    next_cursor: nextCursor,
    total: totalRows[0]?.n ?? 0,
    has_more: hasMore,
  };
}

export async function listForUser(userId: string, opts: { limit: number; cursor?: string }) {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  // Spec REQ-017: user/provider profile aggregates and listings show ONLY
  // client→provider reviews. Without this filter, when the same person acts
  // on both sides of any deal, provider→client reviews would pollute the
  // public rating with semantically incompatible scales (provider role
  // gives overall only; client role gives 4 subscores).
  const where = [
    eq(reviews.reviewee_id, userId),
    eq(reviews.reviewer_role, "client"),
    eq(reviews.status, "published"),
    isNotNull(reviews.revealed_at),
  ];
  const cur = decodeReviewCursor(opts.cursor);
  if (cur) {
    where.push(dsql`(${reviews.revealed_at}, ${reviews.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`);
  }
  const r = await db
    .select({ id: reviews.id, revealed_at: reviews.revealed_at })
    .from(reviews)
    .where(and(...where))
    .orderBy(desc(reviews.revealed_at), desc(reviews.id))
    .limit(limit + 1);
  const hasMore = r.length > limit;
  const slice = r.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last?.revealed_at
    ? Buffer.from(JSON.stringify({ t: last.revealed_at.toISOString(), i: last.id }), "utf8").toString("base64")
    : null;
  const totalRows = await db.execute<{ n: number }>(
    dsql`SELECT COUNT(*)::int AS n FROM reviews
          WHERE reviewee_id = ${userId}
            AND reviewer_role = 'client'
            AND status = 'published' AND revealed_at IS NOT NULL`
  );
  return {
    items: await projectReviews(slice),
    next_cursor: nextCursor,
    total: totalRows[0]?.n ?? 0,
    has_more: hasMore,
  };
}

export async function aggregatesFor(targetType: "listing" | "user", id: string) {
  // Spec REQ-017: profile aggregates count only client→provider reviews.
  // The user-branch SQL now mirrors the listing-branch with the role filter.
  // The previous version had a dead drizzle predicate next to the raw SQL —
  // refactor traps avoided by keeping only the SQL.
  const rows = await db.execute<{ avg_rating: number | null; review_count: number }>(
    targetType === "listing"
      ? dsql`SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS review_count
               FROM reviews
              WHERE listing_id = ${id} AND reviewer_role='client'
                AND status='published' AND revealed_at IS NOT NULL`
      : dsql`SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS review_count
               FROM reviews
              WHERE reviewee_id = ${id} AND reviewer_role='client'
                AND status='published' AND revealed_at IS NOT NULL`
  );
  return {
    avg_rating: rows[0]?.avg_rating ?? null,
    review_count: rows[0]?.review_count ?? 0,
  };
}

/**
 * Spec §4.9 GET /reviews/{id}. SEC-007: identical 404 for "review does not
 * exist" and "review is not publicly visible". Owner (the reviewer) can fetch
 * their own pre-reveal review when authenticated.
 */
export async function getById(
  viewerId: string | null,
  reviewId: string
): Promise<PublicReview | null> {
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) return null;
  const r = await db
    .select({
      id: reviews.id,
      reviewer_id: reviews.reviewer_id,
      status: reviews.status,
      revealed_at: reviews.revealed_at,
    })
    .from(reviews)
    .where(eq(reviews.id, reviewId))
    .limit(1);
  if (r.length === 0) return null;
  const row = r[0]!;
  const publiclyVisible = row.status === "published" && row.revealed_at != null;
  const ownerView = viewerId != null && row.reviewer_id === viewerId;
  if (!publiclyVisible && !ownerView) return null;
  const items = await projectReviews([{ id: row.id }]);
  return items[0] ?? null;
}

export async function listForDeal(viewerId: string, dealId: string) {
  const dr = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (dr.length === 0) return null;
  const d = dr[0]!;
  if (d.client_id !== viewerId && d.provider_id !== viewerId) return "forbidden" as const;
  // Defense-in-depth for v2 blind-reveal: the counterparty must NOT see the
  // other side's review pre-reveal. Today (MVP immediate-reveal) every row
  // passes this gate; the day the reveal default flips, this predicate makes
  // sure /deals/:id/reviews stays safe. SEC-001 fallback since RLS is OOS.
  const r = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(
        eq(reviews.deal_id, dealId),
        dsql`(${reviews.reviewer_id} = ${viewerId} OR (${reviews.status} = 'published' AND ${reviews.revealed_at} IS NOT NULL))`
      )
    );
  return { items: await projectReviews(r, { includeDealRef: true }) };
}
