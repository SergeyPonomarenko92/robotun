/**
 * Module 5 — listings service (MVP cut).
 *
 * IN SCOPE: drafts→active on publish, pause, archive, edit, public list +
 * detail, provider listings, cap enforcement (active+daily) via FOR UPDATE
 * on provider_listing_caps. Outbox events on every transition.
 *
 * OUT OF SCOPE (TODO / future modules): in_review path + admin moderation,
 * listing_reports, listing_appeals, listing_snapshots (Deals), audit_events
 * partitioned table (Module 12), listing_bulk_jobs, KOATUU geo refs (city
 * and region kept as plain TEXT), Ukrainian-FTS dictionary (use ILIKE).
 * trusted-provider rule simplified to "everyone is trusted" — Module 4 KYC
 * will reinstate the gate.
 */
import { and, desc, eq, ilike, or, sql as dsql } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import {
  categories,
  listings,
  outboxEvents,
  listingAuditEvents,
  providerListingCaps,
  users,
} from "../db/schema.js";

const CAP_ACTIVE = 50;
const CAP_CREATED_PER_DAY = 10;

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

const VALID_PRICING = new Set(["fixed", "hourly", "range", "starting_from", "discuss"]);
const VALID_SERVICE = new Set(["on_site", "remote", "both"]);

/** Extract Postgres SQLSTATE from drizzle-wrapped errors. */
function pgCode(e: unknown): string | undefined {
  const o = e as { code?: string; cause?: { code?: string }; original?: { code?: string } };
  return o?.code ?? o?.cause?.code ?? o?.original?.code;
}

export type CreateInput = {
  provider_id: string;
  title: string;
  description: string;
  category_id: string;
  pricing_type: string;
  price_amount?: number | null;
  price_amount_max?: number | null;
  service_type?: string;
  city?: string | null;
  region?: string | null;
  tags?: string[];
  cover_url?: string | null;
  gallery_urls?: string[];
  response_sla_minutes?: number | null;
  draft_id?: string | null;
};

export type UpdateInput = Partial<Omit<CreateInput, "provider_id" | "draft_id">>;

function validatePayload(p: Partial<CreateInput>): ServiceError | null {
  const mk = (fields: Record<string, string>): ServiceError => ({
    code: "validation_failed",
    status: 400,
    details: { fields },
  });
  if (p.title !== undefined) {
    if (typeof p.title !== "string" || p.title.length < 5 || p.title.length > 120) {
      return mk({ title: "length_5_120" });
    }
  }
  if (p.description !== undefined) {
    if (typeof p.description !== "string" || p.description.length < 20 || p.description.length > 5000) {
      return mk({ description: "length_20_5000" });
    }
  }
  if (p.pricing_type !== undefined && !VALID_PRICING.has(p.pricing_type)) {
    return mk({ pricing_type: "invalid" });
  }
  if (p.service_type !== undefined && !VALID_SERVICE.has(p.service_type)) {
    return mk({ service_type: "invalid" });
  }
  if (p.pricing_type) {
    const pt = p.pricing_type;
    const needsAmount = pt === "fixed" || pt === "hourly" || pt === "starting_from" || pt === "range";
    if (needsAmount && (p.price_amount == null || p.price_amount <= 0)) {
      return mk({ price_amount: "required" });
    }
    if (pt === "range" && (p.price_amount_max == null || p.price_amount_max <= (p.price_amount ?? 0))) {
      return mk({ price_amount_max: "must_exceed_min" });
    }
  }
  if (p.tags && (p.tags.length > 20 || p.tags.some((t) => typeof t !== "string" || t.length > 40))) {
    return mk({ tags: "invalid" });
  }
  if (p.gallery_urls && p.gallery_urls.length > 10) {
    return mk({ gallery_urls: "max_10" });
  }
  return null;
}

function priceUnitFor(pt: string): string {
  switch (pt) {
    case "fixed": return "/виклик";
    case "hourly": return "/год";
    case "starting_from": return " від";
    case "range": return " /проект";
    case "discuss": return "";
    default: return "";
  }
}

const PLACEHOLDER_COVER = "https://placehold.co/600x400?text=Robotun";

/**
 * Detail projection — shape adapted to FE `ListingDetail` contract
 * (web/src/lib/listings.ts:28). Aggregates avg_rating + reviews_count +
 * completed_deals_count via LATERAL subqueries (single round-trip, no N+1).
 */
async function project(listingId: string) {
  const rows = await db.execute<{
    id: string;
    title: string;
    description: string;
    status: string;
    pricing_type: string;
    price_amount: number | null;
    price_amount_max: number | null;
    currency: string | null;
    service_type: string;
    city: string | null;
    region: string | null;
    tags: string[];
    cover_url: string | null;
    gallery_urls: string[];
    category_id: string;
    category_name: string;
    provider_id: string | null;
    provider_name: string | null;
    provider_avatar: string | null;
    provider_kyc: string | null;
    response_sla_minutes: number | null;
    published_at: string | null;
    created_at: string;
    updated_at: string;
    avg_rating: number | null;
    reviews_count: number | null;
    completed_deals_count: number | null;
  }>(dsql`
    SELECT l.id, l.title, l.description, l.status, l.pricing_type,
           l.price_amount, l.price_amount_max, l.currency, l.service_type,
           l.city, l.region, l.tags, l.cover_url, l.gallery_urls,
           l.category_id, c.name AS category_name,
           l.provider_id, u.display_name AS provider_name, u.avatar_url AS provider_avatar,
           u.kyc_status AS provider_kyc, l.response_sla_minutes,
           l.published_at, l.created_at, l.updated_at,
           rv.avg_rating, COALESCE(rv.reviews_count, 0) AS reviews_count,
           COALESCE(dc.completed_deals_count, 0) AS completed_deals_count
      FROM listings l
      JOIN categories c ON c.id = l.category_id
      LEFT JOIN users u ON u.id = l.provider_id
      LEFT JOIN LATERAL (
        SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS reviews_count
          FROM reviews r
         WHERE r.reviewee_id = l.provider_id
           AND r.reviewer_role = 'client'
           AND r.status = 'published' AND r.revealed_at IS NOT NULL
      ) rv ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS completed_deals_count
          FROM deals d
         WHERE d.provider_id = l.provider_id AND d.status = 'completed'
      ) dc ON true
     WHERE l.id = ${listingId}
     LIMIT 1
  `);
  const r = rows[0];
  if (!r) return null;
  // FE-shape primary value: price_from_kopecks (single number) — for `range`
  // it's the min, for `discuss` it's 0. Internal fields kept too so own-side
  // editor and management UIs work.
  const priceFromKopecks = r.price_amount ?? 0;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    // FE ListingDetail contract:
    cover_url: r.cover_url ?? PLACEHOLDER_COVER,
    price_from_kopecks: priceFromKopecks,
    price_unit: priceUnitFor(r.pricing_type),
    city: r.city ?? "",
    region: r.region ?? undefined,
    category: r.category_name,
    category_id: r.category_id,
    flags: [
      ...(r.provider_kyc === "approved" ? ["kyc"] : []),
      ...((r.completed_deals_count ?? 0) >= 10 ? ["trusted"] : []),
    ],
    published_at: r.published_at ? new Date(r.published_at).toISOString() : new Date(r.created_at).toISOString(),
    provider: r.provider_id
      ? {
          id: r.provider_id,
          name: r.provider_name ?? "Виконавець",
          avatar_url: r.provider_avatar ?? undefined,
          kyc_verified: r.provider_kyc === "approved",
          avg_rating: r.avg_rating ?? 0,
          reviews_count: r.reviews_count ?? 0,
          completed_deals_count: r.completed_deals_count ?? 0,
        }
      : null,
    // Extended fields for own-listing editor/management.
    pricing_type: r.pricing_type,
    price_amount: r.price_amount,
    price_amount_max: r.price_amount_max,
    currency: r.currency,
    service_type: r.service_type,
    tags: r.tags,
    gallery_urls: r.gallery_urls,
    response_sla_minutes: r.response_sla_minutes,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Ensure provider_listing_caps row exists and reset created_today on a new day. */
async function loadCapsForUpdate(tx: Tx, providerId: string) {
  await tx.execute(
    dsql`INSERT INTO provider_listing_caps (provider_id)
         VALUES (${providerId})
         ON CONFLICT (provider_id) DO NOTHING`
  );
  const rows = await tx.execute<{
    active_count: number;
    draft_count: number;
    created_today: number;
    today_date: string;
  }>(
    dsql`SELECT active_count, draft_count, created_today, today_date::text AS today_date
           FROM provider_listing_caps
          WHERE provider_id = ${providerId}
          FOR UPDATE`
  );
  const row = rows[0]!;
  const todayStr = new Date().toISOString().slice(0, 10);
  if (row.today_date !== todayStr) {
    await tx.execute(
      dsql`UPDATE provider_listing_caps
              SET created_today = 0, today_date = ${todayStr}::date
            WHERE provider_id = ${providerId}`
    );
    row.created_today = 0;
    row.today_date = todayStr;
  }
  return row;
}

/* ------------------------------- CREATE ---------------------------------- */

/**
 * MVP "create" = insert + auto-publish to active inside the same transaction.
 * Real backend has a draft-then-publish two-step; FE wizard treats it as a
 * single "Опублікувати" action. Spec REQ-002 auto-active when trusted, and we
 * temporarily treat all providers as trusted (TODO Module 4 gate).
 */
export async function createListing(
  input: CreateInput
): Promise<Result<{ id: string }>> {
  const v = validatePayload(input);
  if (v) return { ok: false as const, error: v };
  if (!input.category_id) {
    return err("validation_failed", 400, { fields: { category_id: "required" } });
  }
  if (!input.title || !input.description || !input.pricing_type) {
    return err("validation_failed", 400, {
      fields: {
        title: input.title ? undefined : "required",
        description: input.description ? undefined : "required",
        pricing_type: input.pricing_type ? undefined : "required",
      },
    });
  }

  try {
  return await db.transaction(async (tx) => {
    // Trusted-provider gate. Auto-publish (status='active') only for users
    // with kyc_status='approved'. Untrusted providers get a structured
    // 403 so the FE can route them to /provider/kyc with explanatory copy.
    // Module 5 spec calls this REQ-002; closes the prior MVP shortcut
    // ("temporarily treat all providers as trusted").
    const trust = await tx.execute<{ kyc_status: string; status: string }>(
      dsql`SELECT kyc_status, status FROM users WHERE id = ${input.provider_id} LIMIT 1`
    );
    if (trust.length === 0) return err("provider_not_found", 404);
    // pending + active both publish — REQ-001 critic RISK-2. Only
    // suspended/deleted are hard-blocked (mirror of authenticate plugin).
    if (trust[0]!.status === "suspended" || trust[0]!.status === "deleted") {
      return err("provider_not_active", 403);
    }
    if (trust[0]!.kyc_status !== "approved") {
      return err("kyc_required", 403, { current_kyc_status: trust[0]!.kyc_status });
    }

    const caps = await loadCapsForUpdate(tx, input.provider_id);
    if (caps.active_count >= CAP_ACTIVE) {
      return err("cap_exceeded", 429, { code: "active_cap" });
    }
    if (caps.created_today >= CAP_CREATED_PER_DAY) {
      return err("cap_exceeded", 429, { code: "daily_creation_limit" });
    }

    const currency = input.pricing_type === "discuss" ? null : "UAH";
    const now = new Date();

    let inserted;
    try {
      inserted = await tx
        .insert(listings)
        .values({
          provider_id: input.provider_id,
          category_id: input.category_id,
          title: input.title,
          description: input.description,
          status: "active",
          pricing_type: input.pricing_type as
            | "fixed"
            | "hourly"
            | "range"
            | "starting_from"
            | "discuss",
          price_amount: input.price_amount ?? null,
          price_amount_max: input.price_amount_max ?? null,
          currency,
          service_type: (input.service_type ?? "both") as "on_site" | "remote" | "both",
          city: input.city ?? null,
          region: input.region ?? null,
          tags: input.tags ?? [],
          cover_url: input.cover_url ?? null,
          gallery_urls: input.gallery_urls ?? [],
          response_sla_minutes: input.response_sla_minutes ?? null,
          published_at: now,
        })
        .returning({ id: listings.id });
    } catch (e) {
      const ec = pgCode(e);
      if (ec === "P0004") return err("category_not_active", 422);
      if (ec === "23514") return err("validation_failed", 400, { check_violation: true });
      throw e;
    }
    const row = inserted[0]!;

    await tx.execute(
      dsql`UPDATE provider_listing_caps
              SET active_count = active_count + 1,
                  created_today = created_today + 1
            WHERE provider_id = ${input.provider_id}`
    );

    if (input.draft_id) {
      // Best-effort atomic publish-and-cleanup of the wizard draft row.
      await tx.execute(
        dsql`DELETE FROM listing_drafts
              WHERE id = ${input.draft_id} AND owner_user_id = ${input.provider_id}`
      );
    }

    await tx.insert(outboxEvents).values([
      {
        aggregate_type: "listing",
        aggregate_id: row.id,
        event_type: "listing.created",
        payload: { listing_id: row.id, provider_id: input.provider_id, status: "active" },
      },
      {
        aggregate_type: "listing",
        aggregate_id: row.id,
        event_type: "listing.published",
        payload: { listing_id: row.id, provider_id: input.provider_id, category_id: input.category_id },
      },
    ]);

    // REQ-014 anchor — provider-initiated create resets the inactivity
    // clock for the auto-archive sweep (draft path) and gives a forensic
    // breadcrumb for the active path.
    await tx.insert(listingAuditEvents).values({
      listing_id: row.id,
      actor_id: input.provider_id,
      actor_role: "provider",
      event_type: "listing.created",
      from_status: null,
      // createListing inserts in 'active' state (auto-publish path).
      to_status: "active",
    });

    return { ok: true as const, value: { id: row.id } };
  });
  } catch (e) {
    const ec = pgCode(e);
    if (ec === "P0004") return err("category_not_active", 422);
    if (ec === "23514") return err("validation_failed", 400);
    throw e;
  }
}

/* -------------------------------- EDIT ----------------------------------- */

export async function editListing(
  providerId: string,
  listingId: string,
  patch: UpdateInput
): Promise<Result<{ id: string }>> {
  const v = validatePayload(patch);
  if (v) return { ok: false as const, error: v };

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(listings)
      .where(eq(listings.id, listingId))
      .limit(1);
    if (rows.length === 0) return err("listing_not_found", 404);
    const lst = rows[0]!;
    if (lst.provider_id !== providerId) return err("forbidden", 403);
    if (lst.status === "archived") return err("listing_archived", 409);

    const next: Partial<typeof listings.$inferInsert> = {};
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.category_id !== undefined) next.category_id = patch.category_id;
    if (patch.pricing_type !== undefined) {
      next.pricing_type = patch.pricing_type as typeof lst.pricing_type;
      next.currency = patch.pricing_type === "discuss" ? null : "UAH";
    }
    if (patch.price_amount !== undefined) next.price_amount = patch.price_amount ?? null;
    if (patch.price_amount_max !== undefined) next.price_amount_max = patch.price_amount_max ?? null;
    if (patch.service_type !== undefined) next.service_type = patch.service_type as typeof lst.service_type;
    if (patch.city !== undefined) next.city = patch.city ?? null;
    if (patch.region !== undefined) next.region = patch.region ?? null;
    if (patch.tags !== undefined) next.tags = patch.tags;
    if (patch.cover_url !== undefined) next.cover_url = patch.cover_url ?? null;
    if (patch.gallery_urls !== undefined) next.gallery_urls = patch.gallery_urls;
    if (patch.response_sla_minutes !== undefined) {
      next.response_sla_minutes = patch.response_sla_minutes ?? null;
    }
    next.version = (lst.version ?? 1) + 1;

    try {
      await tx.update(listings).set(next).where(eq(listings.id, listingId));
    } catch (e) {
      const ec = pgCode(e);
      if (ec === "P0004") return err("category_not_active", 422);
      if (ec === "23514") return err("validation_failed", 400);
      throw e;
    }

    await tx.insert(outboxEvents).values({
      aggregate_type: "listing",
      aggregate_id: listingId,
      event_type: "listing.edited",
      payload: { listing_id: listingId, changed: Object.keys(next) },
    });

    // REQ-014 — provider edit counts as activity for inactivity sweep.
    await tx.insert(listingAuditEvents).values({
      listing_id: listingId,
      actor_id: providerId,
      actor_role: "provider",
      event_type: "listing.edited",
      from_status: lst.status,
      to_status: lst.status,
      metadata: { changed: Object.keys(next) },
    });

    return { ok: true as const, value: { id: listingId } };
  }).catch((e) => {
    const ec = pgCode(e);
    if (ec === "P0004") return err("category_not_active", 422);
    if (ec === "23514") return err("validation_failed", 400);
    throw e;
  });
}

/* ----------------------------- TRANSITIONS ------------------------------- */

async function transition(
  providerId: string,
  listingId: string,
  expect: ("draft" | "in_review" | "active" | "paused")[],
  to: "active" | "paused" | "archived",
  eventType: string
): Promise<Result<{ id: string; status: string }>> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute<{ provider_id: string | null; status: string }>(
      dsql`SELECT provider_id, status FROM listings WHERE id = ${listingId} FOR UPDATE`
    );
    if (rows.length === 0) return err("listing_not_found", 404);
    const lst = rows[0]!;
    if (lst.provider_id !== providerId) return err("forbidden", 403);
    if (!expect.includes(lst.status as typeof expect[number])) {
      return err("invalid_transition", 409, { from: lst.status, to });
    }

    // Going-active re-checks the active cap — `transition` is reached via
    // publish (paused→active) which would bypass the createListing cap gate
    // otherwise. FOR UPDATE on caps to serialize with concurrent createListing.
    if (to === "active" && lst.status !== "active") {
      await tx.execute(
        dsql`INSERT INTO provider_listing_caps (provider_id) VALUES (${providerId}) ON CONFLICT DO NOTHING`
      );
      const caps = await tx.execute<{ active_count: number }>(
        dsql`SELECT active_count FROM provider_listing_caps WHERE provider_id = ${providerId} FOR UPDATE`
      );
      if ((caps[0]?.active_count ?? 0) >= CAP_ACTIVE) {
        return err("cap_exceeded", 429, { code: "active_cap" });
      }
    }

    const update: Partial<typeof listings.$inferInsert> = { status: to };
    if (to === "active" && lst.status !== "active") update.published_at = new Date();
    if (to === "archived") update.archived_at = new Date();
    try {
      await tx.update(listings).set(update).where(eq(listings.id, listingId));
    } catch (e) {
      const ec = pgCode(e);
      if (ec === "P0004") return err("category_not_active", 422);
      throw e;
    }

    if (to === "active" && lst.status !== "active") {
      await tx.execute(
        dsql`UPDATE provider_listing_caps SET active_count = active_count + 1 WHERE provider_id = ${providerId}`
      );
    }
    if (lst.status === "active" && to !== "active") {
      await tx.execute(
        dsql`UPDATE provider_listing_caps SET active_count = GREATEST(active_count - 1, 0) WHERE provider_id = ${providerId}`
      );
    }

    await tx.insert(outboxEvents).values({
      aggregate_type: "listing",
      aggregate_id: listingId,
      event_type: eventType,
      payload: { listing_id: listingId, from: lst.status, to },
    });

    // REQ-014 — provider-initiated state transitions reset inactivity clock.
    await tx.insert(listingAuditEvents).values({
      listing_id: listingId,
      actor_id: providerId,
      actor_role: "provider",
      event_type: eventType,
      from_status: lst.status,
      to_status: to,
    });

    return { ok: true as const, value: { id: listingId, status: to } };
  });
}

/* ---------------------------- REPORTS / APPEALS --------------------------- */

const REPORT_REASONS = ["spam", "fraud", "illegal_content", "misleading", "duplicate", "other"] as const;
type ReportReason = (typeof REPORT_REASONS)[number];
const REPORT_REASON_SET = new Set<string>(REPORT_REASONS);

/**
 * Module 5 REQ-006 — file abuse report. Reporter qualifying-snapshot is
 * captured here (NOT recomputed by the auto-pause trigger), per the spec
 * §4 schema GENERATED ALWAYS AS column. Snapshot reasons:
 *   - kyc_approved        from users.kyc_status='approved'
 *   - completed_deals     from deals.status='completed' AND client_id=reporter
 *   - account_age_days    from now() - users.created_at
 *
 * The 5/24h-per-reporter + 2/24h-per-provider rate limits are enforced at
 * service tier (DB scan, not Redis Lua — SEC-002 calls for Redis but MVP
 * stays single-source-of-truth on Postgres until the rate-limit module
 * lands).
 */
export async function reportListing(args: {
  listing_id: string;
  reporter_id: string;
  reason: string;
  description?: string;
}): Promise<Result<{ report_id: string }>> {
  if (!REPORT_REASON_SET.has(args.reason)) {
    return err("validation_failed", 400, { fields: { reason: "invalid_enum" } });
  }
  if (args.description != null && args.description.length > 1000) {
    return err("validation_failed", 400, { fields: { description: "max_length_1000" } });
  }
  return await db.transaction(async (tx) => {
    const lst = await tx.execute<{ provider_id: string | null; status: string }>(
      dsql`SELECT provider_id, status FROM listings WHERE id = ${args.listing_id}`
    );
    if (lst.length === 0) return err("listing_not_found", 404);
    if (lst[0]!.provider_id === args.reporter_id) return err("self_report", 422);

    // Rate-limit window 24h, scoped per-reporter + per-(reporter, provider).
    const counts = await tx.execute<{ scope: string; n: string }>(
      dsql`SELECT 'user'::text AS scope, COUNT(*)::text AS n
             FROM listing_reports
            WHERE reporter_id = ${args.reporter_id}
              AND created_at > now() - interval '24 hours'
           UNION ALL
           SELECT 'pair', COUNT(*)::text
             FROM listing_reports lr
             JOIN listings l ON l.id = lr.listing_id
            WHERE lr.reporter_id = ${args.reporter_id}
              AND l.provider_id = ${lst[0]!.provider_id ?? null}
              AND lr.created_at > now() - interval '24 hours'`
    );
    const userN = parseInt(counts.find((c) => c.scope === "user")?.n ?? "0", 10);
    const pairN = parseInt(counts.find((c) => c.scope === "pair")?.n ?? "0", 10);
    if (userN >= 5) return err("report_rate_limited", 429, { scope: "user_24h", limit: 5 });
    if (pairN >= 2) return err("report_rate_limited", 429, { scope: "user_provider_24h", limit: 2 });

    const repRows = await tx.execute<{
      kyc_status: string;
      created_at: Date;
    }>(
      dsql`SELECT kyc_status, created_at FROM users WHERE id = ${args.reporter_id}`
    );
    if (repRows.length === 0) return err("reporter_not_found", 404);
    const ageDays = Math.floor(
      (Date.now() - new Date(repRows[0]!.created_at).getTime()) / (24 * 3600 * 1000)
    );
    const completed = await tx.execute<{ n: string }>(
      dsql`SELECT COUNT(*)::text AS n FROM deals
            WHERE client_id = ${args.reporter_id} AND status = 'completed'`
    );

    try {
      const insRows = await tx.execute<{ id: string }>(
        dsql`INSERT INTO listing_reports (
                listing_id, reporter_id, reason, description,
                reporter_kyc_approved_at_report_time,
                reporter_completed_deals_at_report_time,
                reporter_account_age_days_at_report_time)
              VALUES (
                ${args.listing_id}, ${args.reporter_id}, ${args.reason},
                ${args.description ?? null},
                ${repRows[0]!.kyc_status === "approved"},
                ${parseInt(completed[0]?.n ?? "0", 10)},
                ${ageDays})
              RETURNING id`
      );
      return { ok: true as const, value: { report_id: insRows[0]!.id } };
    } catch (e) {
      const ec = pgCode(e);
      if (ec === "23505") return err("already_reported", 409);
      throw e;
    }
  });
}

/**
 * Module 5 REQ-007 — provider appeals a report_threshold auto-pause.
 * One open appeal per listing (DB UNIQUE partial index).
 */
export async function appealPause(args: {
  listing_id: string;
  provider_id: string;
}): Promise<Result<{ appeal_id: string }>> {
  return await db.transaction(async (tx) => {
    const lst = await tx.execute<{ provider_id: string | null; auto_paused_reasons: string[] }>(
      dsql`SELECT provider_id, auto_paused_reasons FROM listings WHERE id = ${args.listing_id} FOR UPDATE`
    );
    if (lst.length === 0) return err("listing_not_found", 404);
    if (lst[0]!.provider_id !== args.provider_id) return err("forbidden", 403);
    if (!lst[0]!.auto_paused_reasons.includes("report_threshold")) {
      return err("not_appealable", 422, { reasons: lst[0]!.auto_paused_reasons });
    }
    try {
      const ins = await tx.execute<{ id: string }>(
        dsql`INSERT INTO listing_appeals (listing_id, provider_id)
              VALUES (${args.listing_id}, ${args.provider_id})
              RETURNING id`
      );
      await tx.insert(listingAuditEvents).values({
        listing_id: args.listing_id,
        actor_id: args.provider_id,
        actor_role: "provider",
        event_type: "listing.appeal_filed",
        from_status: "paused",
        to_status: "paused",
        metadata: { appeal_id: ins[0]!.id },
      });
      return { ok: true as const, value: { appeal_id: ins[0]!.id } };
    } catch (e) {
      const ec = pgCode(e);
      if (ec === "23505") return err("appeal_already_open", 409);
      throw e;
    }
  });
}

/**
 * Module 5 §4.5.3 — admin resolves a pending report. Outcome:
 *   - 'reviewed'  → action taken; listing already auto-paused via
 *                    report_threshold trigger (if 5th qualifying).
 *   - 'dismissed' → no listing change; report status update only.
 *
 * Audit row written to listing_audit_events with admin actor.
 */
export async function adminResolveReport(args: {
  report_id: string;
  admin_id: string;
  outcome: "reviewed" | "dismissed";
  audit?: { ip?: string | null; user_agent?: string | null };
}): Promise<Result<{ report_id: string; status: string }>> {
  return await db.transaction(async (tx) => {
    const r = await tx.execute<{ id: string; listing_id: string; status: string }>(
      dsql`SELECT id, listing_id, status FROM listing_reports
            WHERE id = ${args.report_id} FOR UPDATE`
    );
    if (r.length === 0) return err("not_found", 404);
    if (r[0]!.status !== "pending") {
      return err("invalid_state", 409, { current_status: r[0]!.status });
    }
    await tx.execute(
      dsql`UPDATE listing_reports
              SET status = ${args.outcome},
                  reviewed_by = ${args.admin_id},
                  reviewed_at = now()
            WHERE id = ${args.report_id}`
    );
    await tx.insert(listingAuditEvents).values({
      listing_id: r[0]!.listing_id,
      actor_id: args.admin_id,
      actor_role: "admin",
      event_type: "listing.report_resolved",
      from_status: null,
      to_status: null,
      metadata: { report_id: args.report_id, outcome: args.outcome },
      ip: args.audit?.ip ?? null,
      user_agent: args.audit?.user_agent ?? null,
    });
    return { ok: true as const, value: { report_id: args.report_id, status: args.outcome } };
  });
}

export const pauseListing = (provider: string, id: string) =>
  transition(provider, id, ["active"], "paused", "listing.paused");
export const archiveListing = (provider: string, id: string) =>
  transition(provider, id, ["draft", "in_review", "active", "paused"], "archived", "listing.archived");

/**
 * Module 5 REQ-002 + §4.4 + SEC-004 + AC-006 + AC-008 — publish path with
 * trusted-provider recompute and system-pause gate.
 *
 *   - draft/paused → active (trusted) | in_review (non-trusted).
 *   - paused: AC-008 — if auto_paused_reasons non-empty → 422
 *     republish_blocked_by_system_pause. Provider must wait for the
 *     consumer/appeal flow to clear the reasons.
 *   - SEC-004: trusted recomputed every publish (no cache) under
 *     SELECT FOR SHARE on users (we use the existing users.kyc_status
 *     denorm; provider_profiles join could be substituted once that
 *     table is denormalized further — same lock semantics).
 *   - AC-006 path B: kyc_status != 'rejected' AND ≥3 distinct clients
 *     with completed deals at agreed_price ≥ 100 UAH (10000 kopecks).
 *   - AC-007 cross-module: if a provider_kyc_revoked reason was applied,
 *     publish must fail until activate consumer clears it (AC-008 same path).
 */
export async function publishListing(
  providerId: string,
  listingId: string
): Promise<Result<{ id: string; status: "active" | "in_review" }>> {
  return await db.transaction(async (tx) => {
    const lst = await tx.execute<{ provider_id: string | null; status: string; auto_paused_reasons: string[]; version: number }>(
      dsql`SELECT provider_id, status, auto_paused_reasons, version FROM listings WHERE id = ${listingId} FOR UPDATE`
    );
    if (lst.length === 0) return err("listing_not_found", 404);
    const row = lst[0]!;
    if (row.provider_id !== providerId) return err("forbidden", 403);
    if (!["draft", "paused", "in_review"].includes(row.status)) {
      return err("invalid_transition", 409, { from: row.status, to: "active" });
    }
    // AC-008 — system-imposed pause must drain first.
    if (row.status === "paused" && row.auto_paused_reasons.length > 0) {
      return err("republish_blocked_by_system_pause", 422, { reasons: row.auto_paused_reasons });
    }

    // SEC-004 / AC-006 trusted recompute. FOR SHARE on the provider's
    // users row holds the snapshot for the duration of the publish tx,
    // so a concurrent KYC revocation can't slip past the gate.
    const pRows = await tx.execute<{ kyc_status: string }>(
      dsql`SELECT kyc_status FROM users WHERE id = ${providerId} FOR SHARE`
    );
    if (pRows.length === 0) return err("provider_not_found", 404);
    const kycStatus = pRows[0]!.kyc_status;

    let trusted = false;
    if (kycStatus === "approved") {
      trusted = true; // Path A.
    } else if (kycStatus !== "rejected") {
      // Path B — kyc_status NOT in {rejected, expired-mapped-to-rejected}.
      // ≥3 distinct clients with status='completed' AND agreed_price >= 10000.
      const dealsRow = await tx.execute<{ n: string }>(
        dsql`SELECT COUNT(DISTINCT client_id)::text AS n
               FROM deals
              WHERE provider_id = ${providerId}
                AND status = 'completed'
                AND agreed_price >= 10000`
      );
      trusted = parseInt(dealsRow[0]?.n ?? "0", 10) >= 3;
    }

    // Going-active cap re-check on the active-count side (paused→active or
    // first-time draft→active both bypass createListing's cap gate otherwise).
    const targetStatus: "active" | "in_review" = trusted ? "active" : "in_review";
    const goingActive = targetStatus === "active" && row.status !== "active";
    if (goingActive) {
      await tx.execute(
        dsql`INSERT INTO provider_listing_caps (provider_id) VALUES (${providerId}) ON CONFLICT DO NOTHING`
      );
      const caps = await tx.execute<{ active_count: number }>(
        dsql`SELECT active_count FROM provider_listing_caps WHERE provider_id = ${providerId} FOR UPDATE`
      );
      if ((caps[0]?.active_count ?? 0) >= CAP_ACTIVE) {
        return err("cap_exceeded", 429, { code: "active_cap" });
      }
    }

    const update: Partial<typeof listings.$inferInsert> = {
      status: targetStatus,
      version: row.version + 1,
      updated_at: new Date(),
    };
    if (targetStatus === "active") update.published_at = new Date();
    await tx.update(listings).set(update).where(eq(listings.id, listingId));

    if (goingActive) {
      await tx.execute(
        dsql`UPDATE provider_listing_caps SET active_count = active_count + 1 WHERE provider_id = ${providerId}`
      );
    }

    const eventType = targetStatus === "active" ? "listing.published" : "listing.submitted_for_review";
    await tx.insert(outboxEvents).values({
      aggregate_type: "listing",
      aggregate_id: listingId,
      event_type: eventType,
      payload: { listing_id: listingId, from: row.status, to: targetStatus, trusted },
    });
    await tx.insert(listingAuditEvents).values({
      listing_id: listingId,
      actor_id: providerId,
      actor_role: "provider",
      event_type: eventType,
      from_status: row.status,
      to_status: targetStatus,
      metadata: { trusted, kyc_status: kycStatus },
    });

    return { ok: true as const, value: { id: listingId, status: targetStatus } };
  });
}

/* --------------------------------- READS --------------------------------- */

export async function getListing(listingId: string, viewerId: string | null) {
  const detail = await project(listingId);
  if (!detail) return null;
  // Non-active listings are visible to owner only.
  if (detail.status !== "active" && detail.provider?.id !== viewerId) return "forbidden" as const;
  return detail;
}

function parseCursor(c: string): { t: string; i: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(c, "base64").toString("utf8"));
    if (typeof obj?.t === "string" && typeof obj?.i === "string" && !isNaN(Date.parse(obj.t))) {
      return obj;
    }
  } catch {}
  return null;
}

export async function listOwn(
  providerId: string,
  opts: { status?: string; limit: number; cursor?: string }
): Promise<Result<{ items: unknown[]; next_cursor: string | null; has_more: boolean }>> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [eq(listings.provider_id, providerId)];
  if (opts.status) where.push(eq(listings.status, opts.status as "active"));
  if (opts.cursor) {
    const cur = parseCursor(opts.cursor);
    if (!cur) return err("invalid_cursor", 400);
    where.push(dsql`(${listings.created_at}, ${listings.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`);
  }
  const rows = await db
    .select()
    .from(listings)
    .where(and(...where))
    .orderBy(desc(listings.created_at), desc(listings.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const cursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ t: last.created_at.toISOString(), i: last.id }), "utf8").toString("base64")
      : null;
  return { ok: true as const, value: { items: slice, next_cursor: cursor, has_more: hasMore } };
}

type ListingCard = {
  id: string;
  title: string;
  cover_url: string;
  price_from_kopecks: number;
  price_unit: string;
  city: string;
  region?: string;
  category: string;
  category_id: string;
  flags: string[];
  provider: {
    id: string;
    name: string;
    avatar_url?: string;
    kyc_verified: boolean;
    avg_rating: number;
    reviews_count: number;
    completed_deals_count: number;
  };
};

export async function listPublic(opts: {
  q?: string;
  category_id?: string;
  city?: string;
  limit: number;
  cursor?: string;
}): Promise<Result<{ items: ListingCard[]; next_cursor: string | null; has_more: boolean }>> {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const where = [eq(listings.status, "active")];
  if (opts.category_id) where.push(eq(listings.category_id, opts.category_id));
  if (opts.city) where.push(eq(listings.city, opts.city));
  if (opts.q && opts.q.length >= 2) {
    // Escape LIKE metacharacters so q='%' isn't a match-all.
    const safe = opts.q.replace(/[\\%_]/g, (m) => "\\" + m);
    where.push(
      or(
        ilike(listings.title, `%${safe}%`),
        ilike(listings.description, `%${safe}%`)
      )!
    );
  }
  if (opts.cursor) {
    const cur = parseCursor(opts.cursor);
    if (!cur) return err("invalid_cursor", 400);
    where.push(
      dsql`(${listings.published_at}, ${listings.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`
    );
  }

  // Use raw SQL for the LATERAL aggregates + JOIN — mirrors feed projection.
  const safeQ = opts.q && opts.q.length >= 2 ? `%${opts.q.replace(/[\\%_]/g, (m) => "\\" + m)}%` : null;
  const params: unknown[] = [];
  const filt: string[] = [`l.status = 'active'`];
  if (opts.category_id) { params.push(opts.category_id); filt.push(`l.category_id = $${params.length}::uuid`); }
  if (opts.city) { params.push(opts.city); filt.push(`l.city = $${params.length}`); }
  if (safeQ) {
    params.push(safeQ);
    filt.push(`(l.title ILIKE $${params.length} ESCAPE '\\' OR l.description ILIKE $${params.length} ESCAPE '\\')`);
  }
  let cursorPred = "";
  if (opts.cursor) {
    const cur = parseCursor(opts.cursor);
    if (!cur) return err("invalid_cursor", 400);
    params.push(cur.t); const ti = params.length;
    params.push(cur.i); const ii = params.length;
    cursorPred = ` AND (l.published_at, l.id::text) < ($${ti}::timestamptz, $${ii}::text)`;
  }
  const sqlText = `
    SELECT l.id, l.title, l.cover_url, l.city, l.region,
           l.category_id, c.name AS category_name,
           l.price_amount, l.pricing_type,
           l.provider_id, l.published_at,
           u.display_name AS provider_name, u.avatar_url AS provider_avatar,
           (u.kyc_approved_at IS NOT NULL) AS provider_kyc_approved,
           rv.avg_rating, COALESCE(rv.reviews_count, 0) AS reviews_count,
           COALESCE(dc.completed_deals_count, 0) AS completed_deals_count
      FROM listings l
      INNER JOIN users u ON u.id = l.provider_id
      INNER JOIN categories c ON c.id = l.category_id
      LEFT JOIN LATERAL (
        SELECT AVG(overall_rating)::float AS avg_rating, COUNT(*)::int AS reviews_count
          FROM reviews
         WHERE reviewee_id = l.provider_id AND reviewer_role='client'
           AND status='published' AND revealed_at IS NOT NULL
      ) rv ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS completed_deals_count
          FROM deals
         WHERE provider_id = l.provider_id AND status='completed'
      ) dc ON true
     WHERE ${filt.join(' AND ')}${cursorPred}
     ORDER BY l.published_at DESC, l.id DESC
     LIMIT ${limit + 1}
  `;
  const rows = (await sql.unsafe(sqlText, params as never[])) as unknown as Array<{
    id: string;
    title: string;
    cover_url: string | null;
    city: string | null;
    region: string | null;
    category_id: string;
    category_name: string;
    price_amount: number | null;
    pricing_type: string;
    provider_id: string | null;
    provider_name: string | null;
    provider_avatar: string | null;
    provider_kyc_approved: boolean;
    avg_rating: number | null;
    reviews_count: number;
    completed_deals_count: number;
    published_at: Date | string | null;
  }>;

  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const lastPub = last?.published_at;
  const cursor =
    hasMore && lastPub
      ? Buffer.from(
          JSON.stringify({
            t: typeof lastPub === "string" ? lastPub : lastPub.toISOString(),
            i: last.id,
          }),
          "utf8"
        ).toString("base64")
      : null;
  const items: ListingCard[] = slice.map((r) => ({
    id: r.id,
    title: r.title,
    cover_url: r.cover_url ?? PLACEHOLDER_COVER,
    price_from_kopecks: r.price_amount ?? 0,
    price_unit: priceUnitFor(r.pricing_type),
    city: r.city ?? "",
    region: r.region ?? undefined,
    category: r.category_name,
    category_id: r.category_id,
    flags: [
      ...(r.provider_kyc_approved ? ["kyc"] : []),
      ...((r.completed_deals_count ?? 0) >= 10 ? ["trusted"] : []),
    ],
    provider: {
      id: r.provider_id ?? "",
      name: r.provider_name ?? "Виконавець",
      avatar_url: r.provider_avatar ?? undefined,
      kyc_verified: !!r.provider_kyc_approved,
      avg_rating: r.avg_rating ?? 0,
      reviews_count: r.reviews_count ?? 0,
      completed_deals_count: r.completed_deals_count ?? 0,
    },
  }));
  return { ok: true as const, value: { items, next_cursor: cursor, has_more: hasMore } };
}

export { project as projectListing };
