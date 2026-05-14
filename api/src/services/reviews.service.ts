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

const REVIEW_WINDOW_DAYS = 60;

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
    const dr = await tx
      .select()
      .from(deals)
      .where(eq(deals.id, input.deal_id))
      .limit(1);
    if (dr.length === 0) return err("deal_not_found", 404);
    const d = dr[0]!;

    const isClient = d.client_id === input.reviewer_id;
    const isProvider = d.provider_id === input.reviewer_id;
    if (!isClient && !isProvider) return err("forbidden", 403);

    // Reviews only on terminal completed/disputed/cancelled deals — but spec
    // is "after completion". MVP: require status='completed'. Drop disputed
    // path until Module 14 is wired.
    if (d.status !== "completed") {
      return err("deal_not_eligible", 409, { current_status: d.status });
    }

    // Window: 60d after completion. Use updated_at as proxy for completed-at
    // (Module 11 will introduce completed_at column).
    const windowEnd = new Date(d.updated_at.getTime() + REVIEW_WINDOW_DAYS * 24 * 3600 * 1000);
    if (Date.now() > windowEnd.getTime()) {
      return err("review_window_closed", 409, { window_until: windowEnd.toISOString() });
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
    if (pgCode(e) === "23505") return err("review_already_exists", 409);
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

type PublicReview = {
  id: string;
  deal_id: string;
  listing_id: string | null;
  reviewer_id: string | null;
  reviewee_id: string;
  reviewer_role: "client" | "provider";
  overall_rating: number;
  quality_rating: number | null;
  communication_rating: number | null;
  timeliness_rating: number | null;
  comment: string | null;
  revealed_at: string;
  reply: { id: string; body: string; author_id: string | null; created_at: string } | null;
};

async function projectReviews(rows: { id: string }[]): Promise<PublicReview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const fullRows = await db
    .select()
    .from(reviews)
    .where(inArray(reviews.id, ids));
  const repliesRows = await db
    .select()
    .from(reviewReplies)
    .where(inArray(reviewReplies.review_id, ids));
  const repByReview = new Map(repliesRows.map((r) => [r.review_id, r]));
  return fullRows.map((r) => {
    const rep = repByReview.get(r.id);
    return {
      id: r.id,
      deal_id: r.deal_id,
      listing_id: r.listing_id,
      reviewer_id: r.reviewer_id,
      reviewee_id: r.reviewee_id,
      reviewer_role: r.reviewer_role,
      overall_rating: r.overall_rating,
      quality_rating: r.quality_rating,
      communication_rating: r.communication_rating,
      timeliness_rating: r.timeliness_rating,
      comment: r.comment,
      revealed_at: r.revealed_at!.toISOString(),
      reply: rep
        ? {
            id: rep.id,
            body: rep.body,
            author_id: rep.author_id,
            created_at: rep.created_at.toISOString(),
          }
        : null,
    };
  });
}

export async function listForListing(listingId: string, opts: { limit: number }) {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const r = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(
        eq(reviews.listing_id, listingId),
        eq(reviews.status, "published"),
        eq(reviews.reviewer_role, "client"),
        isNotNull(reviews.revealed_at)
      )
    )
    .orderBy(desc(reviews.revealed_at))
    .limit(limit);
  return { items: await projectReviews(r) };
}

export async function listForUser(userId: string, opts: { limit: number }) {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const r = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(
        eq(reviews.reviewee_id, userId),
        eq(reviews.status, "published"),
        isNotNull(reviews.revealed_at)
      )
    )
    .orderBy(desc(reviews.revealed_at))
    .limit(limit);
  return { items: await projectReviews(r) };
}

export async function aggregatesFor(targetType: "listing" | "user", id: string) {
  const where =
    targetType === "listing"
      ? and(eq(reviews.listing_id, id), eq(reviews.reviewer_role, "client"))
      : eq(reviews.reviewee_id, id);
  const rows = await db.execute<{ avg_rating: number | null; review_count: number }>(
    targetType === "listing"
      ? dsql`SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS review_count
               FROM reviews
              WHERE listing_id = ${id} AND reviewer_role='client'
                AND status='published' AND revealed_at IS NOT NULL`
      : dsql`SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS review_count
               FROM reviews
              WHERE reviewee_id = ${id}
                AND status='published' AND revealed_at IS NOT NULL`
  );
  return {
    avg_rating: rows[0]?.avg_rating ?? null,
    review_count: rows[0]?.review_count ?? 0,
  };
}

export async function listForDeal(viewerId: string, dealId: string) {
  const dr = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (dr.length === 0) return null;
  const d = dr[0]!;
  if (d.client_id !== viewerId && d.provider_id !== viewerId) return "forbidden" as const;
  const r = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.deal_id, dealId));
  return { items: await projectReviews(r) };
}
