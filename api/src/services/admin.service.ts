/**
 * Module 12 — Admin tooling service (MVP cut).
 *
 * Unified queue read-side, user-detail snapshot, suspend/activate user
 * with version bump (SEC-006 invalidation). Admin actions written as an
 * append-only audit trail.
 */
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { adminActions, outboxEvents, users } from "../db/schema.js";

type ServiceError = { code: string; status: number };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function audit(tx: Tx, args: {
  actor_admin_id: string;
  target_user_id?: string | null;
  target_aggregate_type?: string | null;
  target_aggregate_id?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  user_agent?: string | null;
}) {
  await tx.insert(adminActions).values({
    actor_admin_id: args.actor_admin_id,
    target_user_id: args.target_user_id ?? null,
    target_aggregate_type: args.target_aggregate_type ?? null,
    target_aggregate_id: args.target_aggregate_id ?? null,
    action: args.action,
    metadata: args.metadata ?? {},
    ip: args.ip ?? null,
    user_agent: args.user_agent ?? null,
  });
}

/* ----------------------------- unified queue ----------------------------- */

export async function unifiedQueue(opts: { limit: number }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const rows = await db.execute<{
    source: string;
    id: string;
    created_at: string;
    title: string;
    actor_id: string | null;
  }>(
    dsql`
      (SELECT 'category_proposal' AS source, id::text AS id, created_at, proposed_name AS title, proposer_id AS actor_id
         FROM category_proposals WHERE status = 'pending'
       ORDER BY created_at LIMIT ${limit})
      UNION ALL
      (SELECT 'kyc_submission' AS source, id::text AS id, created_at, 'KYC submission' AS title, provider_id AS actor_id
         FROM kyc_verifications WHERE status = 'submitted' AND reviewed_by IS NULL
       ORDER BY created_at LIMIT ${limit})
      UNION ALL
      (SELECT 'dispute' AS source, id::text AS id, created_at, title AS title, client_id AS actor_id
         FROM deals WHERE status = 'disputed'
       ORDER BY created_at LIMIT ${limit})
      UNION ALL
      (SELECT 'payout' AS source, id::text AS id, requested_at AS created_at, 'Payout request' AS title, provider_id AS actor_id
         FROM payouts WHERE status = 'requested'
       ORDER BY requested_at LIMIT ${limit})
      ORDER BY created_at ASC
      LIMIT ${limit}
    `
  );
  return { items: rows };
}

/* ------------------------- user detail snapshot ------------------------- */

export async function userDetail(userId: string) {
  const u = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (u.length === 0) return null;
  const [counts] = await db.execute<{
    listings: number;
    deals_client: number;
    deals_provider: number;
    reviews_written: number;
    reviews_received: number;
  }>(
    dsql`SELECT
        (SELECT COUNT(*)::int FROM listings WHERE provider_id = ${userId}) AS listings,
        (SELECT COUNT(*)::int FROM deals WHERE client_id = ${userId}) AS deals_client,
        (SELECT COUNT(*)::int FROM deals WHERE provider_id = ${userId}) AS deals_provider,
        (SELECT COUNT(*)::int FROM reviews WHERE reviewer_id = ${userId}) AS reviews_written,
        (SELECT COUNT(*)::int FROM reviews WHERE reviewee_id = ${userId}) AS reviews_received
    `
  );
  return { user: u[0]!, stats: counts ?? {} };
}

/* --------------------------- suspend / activate ------------------------- */

export async function suspendUser(args: {
  admin_id: string;
  target_user_id: string;
  reason: string;
  ip?: string | null;
  ua?: string | null;
}): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(users).where(eq(users.id, args.target_user_id)).limit(1);
    if (rows.length === 0) return { ok: false, error: { code: "user_not_found", status: 404 } };
    const u = rows[0]!;
    if (u.status === "suspended") return { ok: false, error: { code: "already_suspended", status: 409 } };

    await tx
      .update(users)
      .set({ status: "suspended", ver: u.ver + 1, payout_enabled: false })
      .where(eq(users.id, args.target_user_id));

    await audit(tx, {
      actor_admin_id: args.admin_id,
      target_user_id: args.target_user_id,
      action: "user.suspend",
      metadata: { reason: args.reason, prev_status: u.status },
      ip: args.ip ?? null,
      user_agent: args.ua ?? null,
    });

    await tx.insert(outboxEvents).values({
      aggregate_type: "user",
      aggregate_id: args.target_user_id,
      event_type: "user.suspended",
      payload: { user_id: args.target_user_id, reason: args.reason, by_admin: args.admin_id },
    });

    return { ok: true as const, value: { id: args.target_user_id } };
  });
}

export async function activateUser(args: {
  admin_id: string;
  target_user_id: string;
  ip?: string | null;
  ua?: string | null;
}): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(users).where(eq(users.id, args.target_user_id)).limit(1);
    if (rows.length === 0) return { ok: false, error: { code: "user_not_found", status: 404 } };
    const u = rows[0]!;
    if (u.status === "deleted") return { ok: false, error: { code: "user_deleted", status: 409 } };

    await tx
      .update(users)
      .set({ status: "active", ver: u.ver + 1 })
      .where(eq(users.id, args.target_user_id));

    await audit(tx, {
      actor_admin_id: args.admin_id,
      target_user_id: args.target_user_id,
      action: "user.activate",
      metadata: { prev_status: u.status },
      ip: args.ip ?? null,
      user_agent: args.ua ?? null,
    });

    return { ok: true as const, value: { id: args.target_user_id } };
  });
}

/* --------------------------- audit log read ------------------------------ */

export async function listAdminActions(opts: { limit: number; actor_id?: string; target_user_id?: string }) {
  const limit = Math.min(Math.max(opts.limit, 1), 200);
  const where = [];
  if (opts.actor_id) where.push(eq(adminActions.actor_admin_id, opts.actor_id));
  if (opts.target_user_id) where.push(eq(adminActions.target_user_id, opts.target_user_id));
  const rows = await db
    .select()
    .from(adminActions)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(adminActions.created_at))
    .limit(limit);
  return { items: rows };
}

/* --------------------------- platform stats ------------------------------ */

export async function platformStats() {
  const [stats] = await db.execute<{
    users_total: number;
    listings_active: number;
    deals_in_flight: number;
    deals_completed: number;
    deals_disputed: number;
    pending_kyc: number;
    pending_proposals: number;
    pending_payouts: number;
  }>(
    dsql`SELECT
      (SELECT COUNT(*)::int FROM users WHERE status='active') AS users_total,
      (SELECT COUNT(*)::int FROM listings WHERE status='active') AS listings_active,
      (SELECT COUNT(*)::int FROM deals WHERE status IN ('pending','active','in_review')) AS deals_in_flight,
      (SELECT COUNT(*)::int FROM deals WHERE status='completed') AS deals_completed,
      (SELECT COUNT(*)::int FROM deals WHERE status='disputed') AS deals_disputed,
      (SELECT COUNT(*)::int FROM kyc_verifications WHERE status='submitted') AS pending_kyc,
      (SELECT COUNT(*)::int FROM category_proposals WHERE status='pending') AS pending_proposals,
      (SELECT COUNT(*)::int FROM payouts WHERE status='requested') AS pending_payouts
    `
  );
  return stats ?? {};
}
