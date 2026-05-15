/**
 * Module 6 Media pipeline.
 *
 * IN SCOPE: presigned-POST initiate → confirm-HEAD → async ClamAV scan
 * flow for purposes `listing_cover`, `listing_gallery`, `avatar`,
 * `kyc_document`; metadata read; stream (presigned GET redirect);
 * soft-delete; listing-media attach/detach.
 *
 * OUT OF SCOPE (TODO): variants/thumbnails, quarantine→public bucket
 * copy on clean (today both clean and infected stay in original bucket;
 * stream reads from bucket_alias so this is functionally fine — public
 * CDN optimization deferred), message_attachment and dispute_evidence
 * upload via their owning modules, KMS encryption-at-rest of kyc-private,
 * rate limiter partition table.
 *
 * Scan flow:
 *   confirmUpload → status='awaiting_scan' + setImmediate(scanMediaObject)
 *   scanMediaObject → downloadObject + clamav.scanBuffer →
 *     clean    → status='ready' + outbox media.ready
 *     infected → status='quarantine_rejected' + last_scan_error=signature
 *     error    → status='awaiting_scan' (stays for retry by cron)
 */
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { listings, mediaObjects, outboxEvents } from "../db/schema.js";
import {
  bucketNameFor,
  deleteObject,
  downloadObject,
  objectExists,
  presignDownload,
  presignUpload,
  type BucketAlias,
} from "./s3.js";
import { scanBuffer } from "./clamav.js";

const ALLOWED_PURPOSES = new Set([
  "listing_cover",
  "listing_gallery",
  "avatar",
  "kyc_document",
] as const);
type AllowedPurpose = "listing_cover" | "listing_gallery" | "avatar" | "kyc_document";

const PURPOSE_MIMES: Record<AllowedPurpose, Set<string>> = {
  listing_cover: new Set(["image/jpeg", "image/png", "image/webp"]),
  listing_gallery: new Set(["image/jpeg", "image/png", "image/webp"]),
  avatar: new Set(["image/jpeg", "image/png", "image/webp"]),
  kyc_document: new Set(["image/jpeg", "image/png", "application/pdf"]),
};
const MAX_BYTES = 10 * 1024 * 1024;
const KYC_MAX_BYTES = 20 * 1024 * 1024;

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

function buildKey(purpose: AllowedPurpose, mediaId: string, ext: string): string {
  switch (purpose) {
    case "listing_cover":
    case "listing_gallery":
      return `listings/${mediaId}/original${ext}`;
    case "avatar":
      return `avatars/${mediaId}/original${ext}`;
    case "kyc_document":
      return `kyc/${mediaId}/original${ext}`;
  }
}

function extFor(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "application/pdf") return ".pdf";
  return "";
}

/* ------------------------------ INITIATE -------------------------------- */

export async function initiateUpload(args: {
  user_id: string;
  purpose: string;
  listing_id?: string | null;
  mime_type: string;
  byte_size: number;
  original_filename?: string | null;
}): Promise<
  Result<{
    media_id: string;
    method: "POST";
    url: string;
    fields: Record<string, string>;
    expires_at: string;
  }>
> {
  if (!ALLOWED_PURPOSES.has(args.purpose as AllowedPurpose)) {
    return err("unsupported_purpose", 422);
  }
  const purpose = args.purpose as AllowedPurpose;
  if (!PURPOSE_MIMES[purpose].has(args.mime_type)) {
    return err("unsupported_mime", 422);
  }
  const maxBytes = purpose === "kyc_document" ? KYC_MAX_BYTES : MAX_BYTES;
  if (args.byte_size <= 0 || args.byte_size > maxBytes) {
    return err("byte_size_out_of_range", 422, { max: maxBytes });
  }

  // Listing purposes require ownership of the listing.
  if (purpose === "listing_cover" || purpose === "listing_gallery") {
    if (!args.listing_id) return err("listing_id_required", 422);
    const rows = await db
      .select({ provider_id: listings.provider_id, status: listings.status })
      .from(listings)
      .where(eq(listings.id, args.listing_id))
      .limit(1);
    if (rows.length === 0) return err("listing_not_found", 404);
    if (rows[0]!.provider_id !== args.user_id) return err("forbidden", 403);
    if (rows[0]!.status === "archived") return err("listing_archived", 409);
  }

  return await db.transaction(async (tx) => {
    // KYC owners go on owner_user_id (no kyc_documents row yet — KYC service
    // attaches the media after confirm). Listings owners are the listing FK.
    // Avatar owner is the user. chk_exactly_one_owner enforces one-of.
    const ownerUserId = (purpose === "avatar" || purpose === "kyc_document") ? args.user_id : null;
    const listingId = (purpose === "listing_cover" || purpose === "listing_gallery") ? args.listing_id ?? null : null;
    // KYC media skips quarantine entirely — no clamav scan worker in MVP,
    // and the quarantine bucket has dev-side lifecycle rules that would
    // delete PII. Upload directly to kyc-private; promotion to ready still
    // happens on confirm. is_public stays false (enforced by
    // chk_kyc_private_bucket).
    const bucket: "quarantine" | "kyc-private" =
      purpose === "kyc_document" ? "kyc-private" : "quarantine";
    const inserted = await tx
      .insert(mediaObjects)
      .values({
        owner_user_id: ownerUserId,
        listing_id: listingId,
        purpose,
        storage_key: "PLACEHOLDER",
        bucket_alias: bucket,
        original_filename: args.original_filename ?? null,
        mime_type: args.mime_type,
        byte_size: args.byte_size,
        status: "awaiting_upload",
      })
      .returning({ id: mediaObjects.id });
    const mediaId = inserted[0]!.id;

    const ext = extFor(args.mime_type);
    const key = buildKey(purpose, mediaId, ext);
    await tx
      .update(mediaObjects)
      .set({ storage_key: key })
      .where(eq(mediaObjects.id, mediaId));

    const presigned = await presignUpload({
      bucket,
      key,
      contentType: args.mime_type,
      maxBytes: args.byte_size + 1024,
      expiresSeconds: 600,
    });

    return {
      ok: true as const,
      value: {
        media_id: mediaId,
        method: "POST" as const,
        url: presigned.url,
        fields: presigned.fields,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    };
  });
}

/* ------------------------------- CONFIRM -------------------------------- */

/**
 * MVP: skip async scan. HEAD the quarantine object, then immediately move
 * status to `ready` (no scan_attempts increment). Real implementation would
 * enqueue a scan job and the worker would promote on clean result. The
 * `awaiting_scan` state is reached only for the briefest of moments before
 * we update to `ready` in the same tx — clients still get the spec-defined
 * 202 idempotent response shape.
 */
export async function confirmUpload(args: {
  user_id: string;
  media_id: string;
  checksum_sha256?: string | null;
}): Promise<Result<{ media_id: string; status: string }>> {
  const r = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, args.media_id))
      .limit(1);
    if (rows.length === 0) return err("media_not_found", 404);
    const m = rows[0]!;

    // Ownership: any row with owner_user_id set MUST match caller. Listing
    // media uses listing.provider_id since owner_user_id is null there.
    if (m.owner_user_id !== null) {
      if (m.owner_user_id !== args.user_id) return err("forbidden", 403);
    } else if (m.listing_id) {
      const ls = await tx
        .select({ provider_id: listings.provider_id })
        .from(listings)
        .where(eq(listings.id, m.listing_id))
        .limit(1);
      if (ls.length === 0 || ls[0]!.provider_id !== args.user_id) return err("forbidden", 403);
    } else {
      return err("forbidden", 403);
    }

    // Idempotency: re-call on already-ready returns 200 with current state.
    if (m.status === "ready") {
      return { ok: true as const, value: { media_id: m.id, status: m.status } };
    }
    if (m.status === "scan_error_permanent" || m.status === "quarantine_rejected" || m.status === "deleted") {
      return err("media_terminal", 409, { status: m.status, last_scan_error: m.last_scan_error });
    }

    const exists = await objectExists({ bucket: m.bucket_alias as BucketAlias, key: m.storage_key });
    if (!exists.exists) return err("upload_not_found", 409);

    // Confirm → awaiting_scan. The async worker (scanMediaObject) flips
    // to 'ready' or 'quarantine_rejected'. is_public stays based on
    // purpose; the stream endpoint already requires status='ready' for
    // public access, so awaiting_scan rows are not served.
    const now = new Date();
    await tx
      .update(mediaObjects)
      .set({
        status: "awaiting_scan",
        checksum_sha256: args.checksum_sha256 ?? null,
        confirmed_at: now,
        byte_size: exists.contentLength ?? m.byte_size,
        is_public: m.purpose !== "kyc_document",
      })
      .where(eq(mediaObjects.id, m.id));

    return { ok: true as const, value: { media_id: m.id, status: "awaiting_scan" } };
  });
  // Fire-and-forget scan trigger — MUST run AFTER tx.transaction resolves so
  // that scanMediaObject's `WHERE status='awaiting_scan'` predicate sees the
  // committed row. setImmediate inside the tx callback fires before commit
  // and the worker sees stale status, exiting early with scan_attempts=0
  // and the row stuck forever (until the SCAN_STALE_THRESHOLD_MS retry).
  if (r.ok) {
    setImmediate(() => {
      scanMediaObject(r.value.media_id).catch((e) => {
        // eslint-disable-next-line no-console
        console.error(`[scan] media=${r.value.media_id} crashed:`, (e as Error).message);
      });
    });
  }
  return r;
}

/* ----------------------------- SCAN WORKER ------------------------------ */

const SCAN_STALE_THRESHOLD_MS = 120_000;

/**
 * Run ClamAV against one media object. Idempotent — caller can re-invoke
 * if the row stays in awaiting_scan (the cron retry path does this).
 *
 * Result mapping:
 *   - clean    → status='ready' + scan_completed_at + outbox media.ready
 *   - infected → status='quarantine_rejected' + last_scan_error=signature
 *                + outbox media.quarantined (consumed by uploader-facing UX)
 *   - error    → no DB change; cron retries later. Transient daemon
 *                outages should not collapse to permanent quarantine.
 */
export async function scanMediaObject(mediaId: string): Promise<"clean" | "infected" | "error"> {
  const rows = await db
    .select({
      id: mediaObjects.id,
      bucket_alias: mediaObjects.bucket_alias,
      storage_key: mediaObjects.storage_key,
      purpose: mediaObjects.purpose,
      listing_id: mediaObjects.listing_id,
      status: mediaObjects.status,
    })
    .from(mediaObjects)
    .where(eq(mediaObjects.id, mediaId))
    .limit(1);
  if (rows.length === 0) return "error";
  const m = rows[0]!;
  // Only scan rows currently in awaiting_scan. Concurrent confirm races
  // are harmless (no-op).
  if (m.status !== "awaiting_scan") return "error";

  let buf: Buffer;
  try {
    buf = await downloadObject({ bucket: m.bucket_alias as BucketAlias, key: m.storage_key });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[scan] media=${mediaId} download failed:`, (e as Error).message);
    return "error";
  }

  const scan = await scanBuffer(buf);
  const now = new Date();

  if (scan.result === "clean") {
    await db.transaction(async (tx) => {
      const upd = await tx
        .update(mediaObjects)
        .set({ status: "ready", ready_at: now, scan_completed_at: now })
        .where(and(eq(mediaObjects.id, mediaId), eq(mediaObjects.status, "awaiting_scan")))
        .returning({ id: mediaObjects.id });
      if (upd.length === 0) return; // someone else won the race
      await tx.insert(outboxEvents).values({
        aggregate_type: "media",
        aggregate_id: mediaId,
        event_type: "media.ready",
        payload: { media_id: mediaId, purpose: m.purpose, listing_id: m.listing_id },
      });
    });
    return "clean";
  }

  if (scan.result === "infected") {
    await db.transaction(async (tx) => {
      const upd = await tx
        .update(mediaObjects)
        .set({
          status: "quarantine_rejected",
          last_scan_error: scan.signature,
          scan_completed_at: now,
        })
        .where(and(eq(mediaObjects.id, mediaId), eq(mediaObjects.status, "awaiting_scan")))
        .returning({ id: mediaObjects.id });
      if (upd.length === 0) return;
      // Best-effort delete from bucket — infected file should not linger.
      await deleteObject({ bucket: m.bucket_alias as BucketAlias, key: m.storage_key });
      await tx.insert(outboxEvents).values({
        aggregate_type: "media",
        aggregate_id: mediaId,
        event_type: "media.quarantined",
        payload: {
          media_id: mediaId,
          purpose: m.purpose,
          signature: scan.signature,
          listing_id: m.listing_id,
        },
      });
    });
    return "infected";
  }

  // error — leave row in awaiting_scan, mark last_scan_error for visibility.
  await db
    .update(mediaObjects)
    .set({ last_scan_error: scan.message, scan_attempts: dsql`scan_attempts + 1` })
    .where(eq(mediaObjects.id, mediaId));
  // eslint-disable-next-line no-console
  console.warn(`[scan] media=${mediaId} clamav error: ${scan.message}`);
  return "error";
}

/**
 * Cron-driven retry — picks up awaiting_scan rows older than the stale
 * threshold and re-runs scanMediaObject. Handles: server restart while
 * scan was in flight, daemon outage that previously returned 'error'.
 */
export async function scanRetrySweep(): Promise<number> {
  const cutoff = new Date(Date.now() - SCAN_STALE_THRESHOLD_MS);
  const rows = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.status, "awaiting_scan"),
        dsql`${mediaObjects.confirmed_at} <= ${cutoff}`
      )
    )
    .limit(50);
  if (rows.length === 0) return 0;
  let count = 0;
  for (const r of rows) {
    const out = await scanMediaObject(r.id);
    if (out !== "error") count += 1;
  }
  return count;
}

/* ------------------------------- READ ------------------------------------ */

export async function getMetadata(args: { user_id: string | null; media_id: string }): Promise<
  Result<{
    id: string;
    purpose: string;
    mime_type: string;
    byte_size: number;
    width_px: number | null;
    height_px: number | null;
    status: string;
    created_at: string;
    variants: string[];
  }>
> {
  const rows = await db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, args.media_id))
    .limit(1);
  if (rows.length === 0) return err("not_found", 404);
  const m = rows[0]!;
  if (m.purpose === "kyc_document") return err("not_found", 404); // KYC excluded from generic GET
  // Owner or admin only for non-ready listing media; ready public-media is OK.
  if (m.status !== "ready") {
    if (m.owner_user_id && m.owner_user_id !== args.user_id) return err("not_found", 404);
  }
  return {
    ok: true as const,
    value: {
      id: m.id,
      purpose: m.purpose,
      mime_type: m.mime_type,
      byte_size: m.byte_size,
      width_px: m.width_px,
      height_px: m.height_px,
      status: m.status,
      created_at: m.created_at.toISOString(),
      variants: ["original"],
    },
  };
}

/**
 * Returns a presigned GET URL for the stream redirect. Public for active
 * listing media; owner-only for others. KYC stays out of this endpoint.
 */
export async function getStreamUrl(args: { user_id: string | null; media_id: string }): Promise<
  Result<{ url: string }>
> {
  const rows = await db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, args.media_id))
    .limit(1);
  if (rows.length === 0) return err("not_found", 404);
  const m = rows[0]!;
  if (m.status !== "ready") return err("not_found", 404);
  if (m.purpose === "kyc_document") return err("forbidden", 403);

  // Listing visibility check: public iff parent listing is active.
  if (m.listing_id) {
    const ls = await db
      .select({ status: listings.status, provider_id: listings.provider_id })
      .from(listings)
      .where(eq(listings.id, m.listing_id))
      .limit(1);
    const listing = ls[0];
    if (!listing) return err("not_found", 404);
    if (listing.status !== "active" && listing.provider_id !== args.user_id) {
      return err("not_found", 404);
    }
  }
  // Avatar — public.

  const url = await presignDownload({
    bucket: m.bucket_alias as BucketAlias,
    key: m.storage_key,
    expiresSeconds: 300,
  });
  return { ok: true as const, value: { url } };
}

/* ------------------------------- DELETE ---------------------------------- */

export async function softDelete(args: { user_id: string; media_id: string }): Promise<Result<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, args.media_id))
      .limit(1);
    if (rows.length === 0) return err("not_found", 404);
    const m = rows[0]!;

    let ownerOk = false;
    if (m.owner_user_id === args.user_id) ownerOk = true;
    else if (m.listing_id) {
      const ls = await tx
        .select({ provider_id: listings.provider_id })
        .from(listings)
        .where(eq(listings.id, m.listing_id))
        .limit(1);
      ownerOk = ls[0]?.provider_id === args.user_id;
    }
    if (!ownerOk) return err("forbidden", 403);

    await tx
      .update(mediaObjects)
      .set({ status: "deleted", deleted_at: new Date() })
      .where(eq(mediaObjects.id, m.id));
    await tx.insert(outboxEvents).values({
      aggregate_type: "media",
      aggregate_id: m.id,
      event_type: "media.deleted",
      payload: { media_id: m.id, purpose: m.purpose },
    });
    // Best-effort storage cleanup for orphans.
    await deleteObject({ bucket: m.bucket_alias as BucketAlias, key: m.storage_key });

    return { ok: true as const, value: { id: m.id } };
  });
}

/* ---------------------------- LIST OWN MEDIA ----------------------------- */

export async function listOwnMedia(userId: string, opts: { limit: number; cursor?: string }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [eq(mediaObjects.owner_user_id, userId)];
  // Hide kyc_document — never expose via generic listing.
  where.push(dsql`${mediaObjects.purpose} <> 'kyc_document'`);

  const rows = await db
    .select()
    .from(mediaObjects)
    .where(and(...where))
    .orderBy(desc(mediaObjects.created_at))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit), has_more: hasMore };
}
