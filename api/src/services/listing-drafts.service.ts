/**
 * Wizard-autosave drafts. Ephemeral, capped per-user. LRU eviction so the
 * client can keep creating new wizard sessions without bouncing 409s.
 *
 * The shape mirrors the FE contract in web/src/lib/listings.ts.
 */
import { and, asc, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { listingDrafts } from "../db/schema.js";

const MAX_DRAFTS_PER_USER = 10;

export type DraftPayload = Record<string, unknown>;

export type DraftRow = {
  id: string;
  owner_user_id: string;
  payload: DraftPayload;
  created_at: Date;
  updated_at: Date;
};

export type EvictedRef = { id: string; title: string };

function toApi(d: DraftRow) {
  return {
    id: d.id,
    owner_user_id: d.owner_user_id,
    payload: d.payload,
    created_at: d.created_at.toISOString(),
    updated_at: d.updated_at.toISOString(),
  };
}

function titleFrom(payload: DraftPayload): string {
  const t = (payload as { title?: unknown }).title;
  return typeof t === "string" && t.length > 0 ? t : "Без назви";
}

export async function createDraft(ownerId: string) {
  return await db.transaction(async (tx) => {
    // Serialize concurrent createDraft per user — otherwise two tabs both read
    // existing.length=10 and both INSERT, blowing the cap. Namespace 2 reserved
    // for listing_drafts (PAT-002 of Module 10 uses namespace 1 for slugs).
    await tx.execute(
      dsql`SELECT pg_advisory_xact_lock(2::int4, hashtext(${"listing_drafts:" + ownerId})::int4)`
    );
    const existing = await tx
      .select()
      .from(listingDrafts)
      .where(eq(listingDrafts.owner_user_id, ownerId))
      .orderBy(asc(listingDrafts.updated_at));

    const evicted: EvictedRef[] = [];
    if (existing.length >= MAX_DRAFTS_PER_USER) {
      const overflow = existing.slice(0, existing.length - MAX_DRAFTS_PER_USER + 1);
      for (const d of overflow) {
        evicted.push({ id: d.id, title: titleFrom(d.payload as DraftPayload) });
        await tx.delete(listingDrafts).where(eq(listingDrafts.id, d.id));
      }
    }

    const [row] = await tx
      .insert(listingDrafts)
      .values({ owner_user_id: ownerId, payload: {} })
      .returning();
    return { ...toApi(row! as DraftRow), evicted };
  });
}

export async function listDrafts(ownerId: string) {
  const rows = await db
    .select()
    .from(listingDrafts)
    .where(eq(listingDrafts.owner_user_id, ownerId))
    .orderBy(desc(listingDrafts.updated_at));
  return rows.map((r) => toApi(r as DraftRow));
}

export async function getDraft(ownerId: string, id: string) {
  const rows = await db
    .select()
    .from(listingDrafts)
    .where(eq(listingDrafts.id, id))
    .limit(1);
  if (rows.length === 0) return { ok: false as const, code: "not_found", status: 404 };
  const d = rows[0]!;
  if (d.owner_user_id !== ownerId) return { ok: false as const, code: "forbidden", status: 403 };
  return { ok: true as const, value: toApi(d as DraftRow) };
}

export async function patchDraft(ownerId: string, id: string, payloadDelta: DraftPayload) {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(listingDrafts)
      .where(eq(listingDrafts.id, id))
      .limit(1);
    if (rows.length === 0) return { ok: false as const, code: "not_found", status: 404 };
    const d = rows[0]!;
    if (d.owner_user_id !== ownerId) return { ok: false as const, code: "forbidden", status: 403 };

    const merged = { ...(d.payload as DraftPayload), ...payloadDelta };
    const [u] = await tx
      .update(listingDrafts)
      .set({ payload: merged })
      .where(eq(listingDrafts.id, id))
      .returning();
    return { ok: true as const, value: toApi(u! as DraftRow) };
  });
}

export async function deleteDraftById(ownerId: string, id: string) {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(listingDrafts)
      .where(eq(listingDrafts.id, id))
      .limit(1);
    if (rows.length === 0) return { ok: true as const };
    if (rows[0]!.owner_user_id !== ownerId) {
      return { ok: false as const, code: "forbidden", status: 403 };
    }
    await tx.delete(listingDrafts).where(eq(listingDrafts.id, id));
    return { ok: true as const };
  });
}
