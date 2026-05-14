/**
 * Module 5 ↔ Module 6 bridge — attach/detach media to listings + sync the
 * denormalized listings.cover_url / gallery_urls projection so the FE
 * detail view keeps working without an extra join.
 *
 * Single-cover invariant is enforced by trg_enforce_single_cover (P0001).
 * Gallery cap of 10 enforced server-side here.
 */
import { and, asc, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { listingMedia, listings, mediaObjects } from "../db/schema.js";
import { presignDownload, type BucketAlias } from "./s3.js";

const GALLERY_CAP = 10;

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

async function syncListingUrls(listingId: string) {
  // Compute cover + gallery URLs and write to listings row so detail GET
  // stays a single-query projection.
  //
  // KNOWN DEBT (deep-review): we cache 24h presigned-GET URLs on the listing
  // row. They expire daily, so without a sync re-run FE renders broken
  // images. The proper fix is either a public bucket with public-read on
  // ready listing media (and store stable URLs) or a redirect via
  // /media/:id/stream. Tracked as Module 6 follow-up.
  const rows = await db
    .select({
      id: mediaObjects.id,
      purpose: mediaObjects.purpose,
      bucket_alias: mediaObjects.bucket_alias,
      storage_key: mediaObjects.storage_key,
      status: mediaObjects.status,
      order: listingMedia.display_order,
    })
    .from(listingMedia)
    .innerJoin(mediaObjects, eq(mediaObjects.id, listingMedia.media_id))
    .where(
      and(eq(listingMedia.listing_id, listingId), eq(mediaObjects.status, "ready"))
    )
    .orderBy(asc(listingMedia.display_order));

  let cover: string | null = null;
  const gallery: string[] = [];
  for (const r of rows) {
    const url = await presignDownload({
      bucket: r.bucket_alias as BucketAlias,
      key: r.storage_key,
      expiresSeconds: 24 * 3600,
    });
    if (r.purpose === "listing_cover") cover = url;
    else if (r.purpose === "listing_gallery") gallery.push(url);
  }
  await db.update(listings).set({ cover_url: cover, gallery_urls: gallery }).where(eq(listings.id, listingId));
}

export async function attach(args: {
  user_id: string;
  listing_id: string;
  media_id: string;
  display_order?: number;
}): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    // FOR UPDATE on the listing row serializes concurrent attaches per
    // listing so the gallery-cap check below cannot race past the limit.
    const listingRow = await tx.execute<{ provider_id: string | null; status: string }>(
      dsql`SELECT provider_id, status FROM listings WHERE id = ${args.listing_id} FOR UPDATE`
    );
    if (listingRow.length === 0) return err("listing_not_found", 404);
    if (listingRow[0]!.provider_id !== args.user_id) return err("forbidden", 403);
    if (listingRow[0]!.status === "archived") return err("listing_archived", 409);

    const m = await tx
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, args.media_id))
      .limit(1);
    if (m.length === 0) return err("media_not_found", 404);
    const media = m[0]!;
    if (media.listing_id !== args.listing_id) return err("media_listing_mismatch", 422);
    if (media.purpose !== "listing_cover" && media.purpose !== "listing_gallery") {
      return err("invalid_purpose", 422);
    }
    if (media.status !== "ready") return err("media_not_ready", 409, { status: media.status });

    // Cap gallery items at GALLERY_CAP (cover excluded).
    if (media.purpose === "listing_gallery") {
      const c = await tx
        .select({ id: listingMedia.id })
        .from(listingMedia)
        .innerJoin(mediaObjects, eq(mediaObjects.id, listingMedia.media_id))
        .where(
          and(
            eq(listingMedia.listing_id, args.listing_id),
            eq(mediaObjects.purpose, "listing_gallery")
          )
        );
      if (c.length >= GALLERY_CAP) return err("gallery_cap_exceeded", 429, { cap: GALLERY_CAP });
    }

    const inserted = await tx
      .insert(listingMedia)
      .values({
        listing_id: args.listing_id,
        media_id: args.media_id,
        display_order: args.display_order ?? 0,
      })
      .returning({ id: listingMedia.id });
    const linkId = inserted[0]!.id;
    return { ok: true as const, value: { id: linkId } };
  }).then(async (r) => {
    if (r.ok) await syncListingUrls(args.listing_id);
    return r;
  }).catch((e) => {
    const ec = pgCode(e);
    if (ec === "P0001") return err("cover_already_exists", 409);
    if (ec === "23505") return err("media_already_attached", 409);
    throw e;
  });
}

export async function detach(args: {
  user_id: string;
  listing_id: string;
  media_id: string;
}): Promise<Result<{ ok: true }>> {
  return await db.transaction(async (tx) => {
    const listingRow = await tx
      .select({ provider_id: listings.provider_id })
      .from(listings)
      .where(eq(listings.id, args.listing_id))
      .limit(1);
    if (listingRow.length === 0) return err("listing_not_found", 404);
    if (listingRow[0]!.provider_id !== args.user_id) return err("forbidden", 403);

    await tx
      .delete(listingMedia)
      .where(
        and(
          eq(listingMedia.listing_id, args.listing_id),
          eq(listingMedia.media_id, args.media_id)
        )
      );
    return { ok: true as const, value: { ok: true as const } };
  }).then(async (r) => {
    if (r.ok) await syncListingUrls(args.listing_id);
    return r;
  });
}

export { syncListingUrls };
