/**
 * Module 10 — category tree service. Implements REQ-001..REQ-011 + concurrency
 * model from §4.5. Out of scope at MVP backend port: audit_events writes (Module
 * 12 owns the table), Redis cache/single-flight (GET hits DB directly per AC-015
 * fallback), Lua rate limits (TODO — gate via @fastify/rate-limit at route),
 * async archival job for >20 descendants (sync path returns 422 instead).
 */
import { and, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import {
  categories,
  categoryProposals,
  outboxEvents,
} from "../db/schema.js";
import { normalizeSlug, validateSlugOverride } from "./slug.js";

export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  level: number;
  childrenCount: number;
  children: CategoryNode[];
};

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

/* ---------------------------------- read --------------------------------- */

export async function getTree(): Promise<CategoryNode[]> {
  const rows = await db
    .select({
      id: categories.id,
      parent_id: categories.parent_id,
      slug: categories.slug,
      name: categories.name,
      level: categories.level,
    })
    .from(categories)
    .where(eq(categories.status, "active"))
    .orderBy(categories.level, categories.name);

  const byId = new Map<string, CategoryNode>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      slug: r.slug,
      name: r.name,
      level: r.level,
      childrenCount: 0,
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parent_id && byId.has(r.parent_id)) {
      const parent = byId.get(r.parent_id)!;
      parent.children.push(node);
      parent.childrenCount += 1;
    } else if (r.parent_id === null) {
      roots.push(node);
    }
  }
  return roots;
}

/* -------------------------- proposer self-list --------------------------- */

type Cursor = { t: string; i: string };
function decodeCursor(c: string | undefined): Cursor | null {
  if (!c) return null;
  try {
    const parsed = JSON.parse(Buffer.from(c, "base64").toString("utf8"));
    if (typeof parsed.t === "string" && typeof parsed.i === "string") return parsed;
  } catch {}
  return null;
}
function encodeCursor(t: Date, i: string): string {
  return Buffer.from(JSON.stringify({ t: t.toISOString(), i }), "utf8").toString("base64");
}

export async function listOwnProposals(
  proposerId: string,
  opts: { status?: "pending" | "approved" | "rejected" | "auto_rejected" | "all"; limit: number; cursor?: string }
) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const cur = decodeCursor(opts.cursor);
  const where = [eq(categoryProposals.proposer_id, proposerId)];
  if (opts.status && opts.status !== "all") where.push(eq(categoryProposals.status, opts.status));
  if (cur) {
    where.push(dsql`(${categoryProposals.created_at}, ${categoryProposals.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`);
  }

  const rows = await db
    .select()
    .from(categoryProposals)
    .where(and(...where))
    .orderBy(desc(categoryProposals.created_at), desc(categoryProposals.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
  return { items: slice, next_cursor: nextCursor, has_more: hasMore };
}

/* -------------------------- propose (user-path) -------------------------- */

export async function submitProposal(args: {
  proposer_id: string;
  parent_category_id: string;
  proposed_name: string;
}): Promise<Result<{ id: string; proposed_slug: string; status: "pending"; created_at: Date }>> {
  if (args.proposed_name.length < 2 || args.proposed_name.length > 120) {
    return err("invalid_name", 422);
  }
  const slugR = normalizeSlug(args.proposed_name);
  if (!slugR.ok) {
    return err(
      slugR.reason === "reserved_slug" ? "reserved_slug" : "invalid_slug",
      422
    );
  }
  const finalSlug = slugR.slug;

  return await db.transaction(async (tx) => {
    const parent = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, args.parent_category_id))
      .limit(1);
    if (parent.length === 0) return err("parent_not_found", 404);
    const p = parent[0]!;
    if (p.status !== "active") return err("parent_archived", 422);
    if (p.level >= 3) return err("max_depth_exceeded", 422);

    // §4.5 — advisory lock on slug critical section. Namespace=1, key=hashtext.
    await tx.execute(
      dsql`SELECT pg_advisory_xact_lock(1::int4, hashtext(${"proposal:slug:" + finalSlug})::int4)`
    );

    const dupActive = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.slug, finalSlug), eq(categories.status, "active")))
      .limit(1);
    if (dupActive.length > 0) return err("duplicate_category", 409);

    const dupPending = await tx
      .select({ id: categoryProposals.id })
      .from(categoryProposals)
      .where(
        and(
          eq(categoryProposals.proposed_slug, finalSlug),
          eq(categoryProposals.status, "pending")
        )
      )
      .limit(1);
    if (dupPending.length > 0) return err("duplicate_category", 409);

    const inserted = await tx
      .insert(categoryProposals)
      .values({
        proposer_id: args.proposer_id,
        parent_category_id: args.parent_category_id,
        proposed_name: args.proposed_name,
        proposed_slug: finalSlug,
        status: "pending",
      })
      .returning();
    const row = inserted[0]!;

    await tx.insert(outboxEvents).values({
      aggregate_type: "category_proposal",
      aggregate_id: row.id,
      event_type: "category.proposed",
      payload: {
        proposal_id: row.id,
        proposer_id: args.proposer_id,
        parent_category_id: args.parent_category_id,
        proposed_name: args.proposed_name,
        proposed_slug: finalSlug,
      },
    });

    return {
      ok: true as const,
      value: {
        id: row.id,
        proposed_slug: row.proposed_slug,
        status: "pending" as const,
        created_at: row.created_at,
      },
    };
  });
}

/* ----------------------------- admin: approve ---------------------------- */

export async function approveProposal(args: {
  proposal_id: string;
  admin_id: string;
  slug_override?: string;
  note?: string;
}): Promise<Result<{ category_id: string; slug: string; level: number }>> {
  return await db.transaction(async (tx) => {
    const proposal = await tx
      .select()
      .from(categoryProposals)
      .where(eq(categoryProposals.id, args.proposal_id))
      .limit(1);
    if (proposal.length === 0) return err("proposal_not_found", 404);
    const pr = proposal[0]!;
    if (pr.status !== "pending") return err("proposal_not_pending", 409);

    let finalSlug = pr.proposed_slug;
    if (args.slug_override) {
      const v = validateSlugOverride(args.slug_override);
      if (!v.ok) return err("invalid_slug_override", 422);
      finalSlug = v.slug;
    }

    await tx.execute(
      dsql`SELECT pg_advisory_xact_lock(1::int4, hashtext(${"proposal:slug:" + pr.proposed_slug})::int4)`
    );
    // When slug_override differs, the advisory lock above guards only the
    // proposal's stored slug. Take a second lock keyed on finalSlug to
    // serialize against concurrent submits/admin-creates targeting it.
    if (finalSlug !== pr.proposed_slug) {
      await tx.execute(
        dsql`SELECT pg_advisory_xact_lock(1::int4, hashtext(${"proposal:slug:" + finalSlug})::int4)`
      );
    }

    // FOR UPDATE row-lock the proposal.
    const locked = await tx.execute(
      dsql`SELECT id FROM category_proposals WHERE id = ${args.proposal_id} AND status = 'pending' FOR UPDATE`
    );
    if (locked.count === 0) return err("proposal_not_pending", 409);

    // §4.5 step 4 — FOR UPDATE guards against concurrent admin-create racing
    // to the same slug.
    const dup = await tx.execute(
      dsql`SELECT id FROM categories WHERE slug = ${finalSlug} AND status = 'active' FOR UPDATE`
    );
    if (dup.count > 0) return err("duplicate_category", 409);

    const parent = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, pr.parent_category_id))
      .limit(1);
    if (parent.length === 0) return err("parent_not_found", 404);
    if (parent[0]!.status !== "active") return err("parent_archived", 422);
    if (parent[0]!.level >= 3) return err("max_depth_exceeded", 422);

    // Auto-reject race losers (other pending proposals targeting the same
    // override slug — possible only when slug_override is used; the partial
    // uq_proposal_slug_pending precludes two pending rows with identical
    // proposed_slug otherwise).
    const losers = await tx
      .update(categoryProposals)
      .set({
        status: "auto_rejected",
        auto_rejected: true,
        rejection_code: "duplicate_category",
        reviewed_by: args.admin_id,
        reviewed_at: new Date(),
      })
      .where(
        and(
          eq(categoryProposals.proposed_slug, finalSlug),
          eq(categoryProposals.status, "pending"),
          dsql`${categoryProposals.id} <> ${args.proposal_id}`
        )
      )
      .returning({ id: categoryProposals.id });

    // Flip the winner to 'approved' BEFORE inserting the category — otherwise
    // trg_categories_pending_slug_check raises P0006 against the winner's own
    // still-pending row.
    await tx
      .update(categoryProposals)
      .set({
        status: "approved",
        reviewed_by: args.admin_id,
        reviewed_at: new Date(),
        rejection_note: args.note ?? null,
      })
      .where(eq(categoryProposals.id, args.proposal_id));

    // INSERT category — level computed by trigger; CHECK passes via 2.
    // Spec §4.5 inverts step 6 and 7 because trg_categories_pending_slug_check
    // reads the winner's own pending row → P0006. We flipped the proposal to
    // 'approved' just above; INSERT now sees zero pending rows for finalSlug.
    let cat;
    try {
      const inserted = await tx
        .insert(categories)
        .values({
          parent_id: pr.parent_category_id,
          level: 2, // overwritten by BEFORE INSERT trigger
          name: pr.proposed_name,
          slug: finalSlug,
          creator_id: pr.proposer_id,
          admin_created: false,
        })
        .returning();
      cat = inserted[0]!;
    } catch (e) {
      const ec = (e as { code?: string }).code;
      if (ec === "P0006" || ec === "23505") return err("duplicate_category", 409);
      if (ec === "P0003") return err("max_depth_exceeded", 422);
      throw e;
    }

    await tx.insert(outboxEvents).values([
      {
        aggregate_type: "category",
        aggregate_id: cat.id,
        event_type: "category.approved",
        payload: {
          category_id: cat.id,
          proposal_id: args.proposal_id,
          slug: cat.slug,
          name: cat.name,
          parent_id: cat.parent_id,
          level: cat.level,
          slug_overridden: !!args.slug_override,
        },
      },
      ...losers.map((l) => ({
        aggregate_type: "category_proposal",
        aggregate_id: l.id,
        event_type: "category.auto_rejected",
        payload: { proposal_id: l.id, winner_proposal_id: args.proposal_id },
      })),
    ]);

    return { ok: true as const, value: { category_id: cat.id, slug: cat.slug, level: cat.level } };
  });
}

/* ------------------------------ admin: reject ---------------------------- */

export async function rejectProposal(args: {
  proposal_id: string;
  actor_id: string;
  rejection_code: "policy_violation" | "admin_override" | "duplicate_category" | "parent_archived" | "max_depth_exceeded";
  note?: string;
}): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ status: categoryProposals.status })
      .from(categoryProposals)
      .where(eq(categoryProposals.id, args.proposal_id))
      .limit(1);
    if (existing.length === 0) return err("proposal_not_found", 404);
    if (existing[0]!.status !== "pending") return err("proposal_not_pending", 409);

    await tx
      .update(categoryProposals)
      .set({
        status: "rejected",
        rejection_code: args.rejection_code,
        rejection_note: args.note ?? null,
        reviewed_by: args.actor_id,
        reviewed_at: new Date(),
      })
      .where(
        and(
          eq(categoryProposals.id, args.proposal_id),
          eq(categoryProposals.status, "pending")
        )
      );

    await tx.insert(outboxEvents).values({
      aggregate_type: "category_proposal",
      aggregate_id: args.proposal_id,
      event_type: "category.rejected",
      payload: {
        proposal_id: args.proposal_id,
        rejection_code: args.rejection_code,
        rejection_note: args.note ?? null,
        actor_id: args.actor_id,
      },
    });

    return { ok: true as const, value: { id: args.proposal_id } };
  });
}

/* --------------------------- admin: direct create ------------------------ */

export async function adminCreate(args: {
  admin_id: string;
  name: string;
  parent_id: string | null;
  slug_override?: string;
}): Promise<Result<{ id: string; slug: string; level: number }>> {
  if (args.name.length < 2 || args.name.length > 120) return err("invalid_name", 422);

  let slug: string;
  if (args.slug_override) {
    const v = validateSlugOverride(args.slug_override);
    if (!v.ok) return err("invalid_slug_override", 422);
    slug = v.slug;
  } else {
    const v = normalizeSlug(args.name);
    if (!v.ok) return err(v.reason === "reserved_slug" ? "reserved_slug" : "invalid_slug", 422);
    slug = v.slug;
  }

  return await db.transaction(async (tx) => {
    if (args.parent_id) {
      const parent = await tx
        .select()
        .from(categories)
        .where(eq(categories.id, args.parent_id))
        .limit(1);
      if (parent.length === 0) return err("parent_not_found", 404);
      if (parent[0]!.status !== "active") return err("parent_archived", 422);
      if (parent[0]!.level >= 3) return err("max_depth_exceeded", 422);
    }

    await tx.execute(
      dsql`SELECT pg_advisory_xact_lock(1::int4, hashtext(${"proposal:slug:" + slug})::int4)`
    );

    const dup = await tx.execute(
      dsql`SELECT id FROM categories WHERE slug = ${slug} AND status = 'active' FOR UPDATE`
    );
    if (dup.count > 0) return err("duplicate_category", 409);

    try {
      const inserted = await tx
        .insert(categories)
        .values({
          parent_id: args.parent_id,
          level: args.parent_id ? 2 : 1, // overwritten by trigger
          name: args.name,
          slug,
          admin_created: true,
          creator_id: args.admin_id,
        })
        .returning();
      const cat = inserted[0]!;

      await tx.insert(outboxEvents).values({
        aggregate_type: "category",
        aggregate_id: cat.id,
        event_type: "category.admin_created",
        payload: { category_id: cat.id, slug: cat.slug, parent_id: cat.parent_id, level: cat.level },
      });

      return { ok: true as const, value: { id: cat.id, slug: cat.slug, level: cat.level } };
    } catch (e) {
      const ec = (e as { code?: string }).code;
      if (ec === "P0006" || ec === "23505") return err("duplicate_category", 409);
      if (ec === "P0003") return err("max_depth_exceeded", 422);
      throw e;
    }
  });
}

/* ------------------------------- admin: archive -------------------------- */

export async function archiveCategory(args: {
  category_id: string;
  admin_id: string;
  cascade: boolean;
}): Promise<Result<{ archived: string[] }>> {
  return await db.transaction(async (tx) => {
    await tx.execute(dsql`SET LOCAL statement_timeout = '5s'`);

    const target = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, args.category_id))
      .limit(1);
    if (target.length === 0) return err("category_not_found", 404);
    if (target[0]!.status !== "active") return err("already_archived", 409);

    const descendants = await tx.execute<{ id: string }>(dsql`
      WITH RECURSIVE sub AS (
        SELECT id FROM categories WHERE parent_id = ${args.category_id} AND status = 'active'
        UNION ALL
        SELECT c.id FROM categories c
          JOIN sub s ON c.parent_id = s.id
         WHERE c.status = 'active'
      )
      SELECT id FROM sub
    `);
    const descIds = descendants.map((r) => r.id);

    if (descIds.length > 0 && !args.cascade) {
      return err("has_active_children", 409);
    }
    if (descIds.length > 20) {
      // Spec §4.6.6 routes >20 to async job; backend MVP returns 422 with hint.
      return err("descendants_exceed_sync_cap", 422, { count: descIds.length });
    }

    const ids = [args.category_id, ...descIds];
    await tx
      .update(categories)
      .set({ status: "archived" })
      .where(inArray(categories.id, ids));
    await tx
      .update(categoryProposals)
      .set({
        status: "auto_rejected",
        auto_rejected: true,
        rejection_code: "parent_archived",
        reviewed_by: args.admin_id,
        reviewed_at: new Date(),
      })
      .where(
        and(
          inArray(categoryProposals.parent_category_id, ids),
          eq(categoryProposals.status, "pending")
        )
      );

    await tx.insert(outboxEvents).values(
      ids.map((id) => ({
        aggregate_type: "category" as const,
        aggregate_id: id,
        event_type: "category.archived",
        payload: { category_id: id, cascade: args.cascade, root_id: args.category_id },
      }))
    );

    return { ok: true as const, value: { archived: ids } };
  });
}

/* ----------------------------- admin: edit name -------------------------- */

export async function editCategoryName(args: {
  category_id: string;
  admin_id: string;
  name: string;
}): Promise<Result<{ id: string; name: string }>> {
  if (args.name.length < 2 || args.name.length > 120) return err("invalid_name", 422);

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, args.category_id))
      .limit(1);
    if (rows.length === 0) return err("category_not_found", 404);
    if (rows[0]!.status !== "active") return err("category_not_active", 422);
    const old = rows[0]!;

    await tx
      .update(categories)
      .set({ name: args.name })
      .where(eq(categories.id, args.category_id));

    await tx.insert(outboxEvents).values({
      aggregate_type: "category",
      aggregate_id: args.category_id,
      event_type: "category.name_edited",
      payload: { category_id: args.category_id, old_name: old.name, new_name: args.name },
    });

    return { ok: true as const, value: { id: args.category_id, name: args.name } };
  });
}

/* ------------------------------ admin: list ------------------------------ */

export async function listPendingProposals(opts: { limit: number; cursor?: string }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const cur = decodeCursor(opts.cursor);
  const where = [eq(categoryProposals.status, "pending")];
  if (cur) {
    where.push(dsql`(${categoryProposals.created_at}, ${categoryProposals.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`);
  }

  const rows = await db
    .select()
    .from(categoryProposals)
    .where(and(...where))
    .orderBy(desc(categoryProposals.created_at), desc(categoryProposals.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
  return { items: slice, next_cursor: nextCursor, has_more: hasMore };
}
