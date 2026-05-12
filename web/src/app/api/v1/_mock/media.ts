/**
 * Module 6 (Media Pipeline) — Step 1 mock store.
 *
 * Two-phase upload: initiate → POST blob → confirm. In production:
 *   - upload_url + fields are an S3 presigned POST envelope (spec §4.5.1)
 *   - confirm HEAD-checks quarantine bucket, sets status='awaiting_scan',
 *     enqueues ClamAV worker (pgmq). On clean scan worker COPYs to target
 *     bucket and promotes to 'ready'.
 * In this mock: blob is stored in an in-memory Map; confirm flips status to
 * 'ready' instantly (skips scan). The mock comment notes the prod path.
 *
 * Per spec §4.1.2 (dispute_evidence purpose contract): owner_user_id MUST be
 * NULL — ownership is transitive via dispute_evidence row (which doesn't exist
 * yet at initiate time). We store `uploader_user_id` separately to authorize
 * confirm/stream/validateAttachments without violating that FK contract.
 */

export type MediaPurpose =
  | "listing_cover"
  | "listing_gallery"
  | "listing_attachment"
  | "kyc_document"
  | "avatar"
  | "dispute_evidence";

export type MediaStatus = "awaiting_upload" | "ready" | "deleted";

export type MockMediaObject = {
  id: string;
  uploader_user_id: string; // distinct from owner_user_id (spec §4.1.2)
  owner_user_id: string | null;
  purpose: MediaPurpose;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  status: MediaStatus;
  confirmed_at: string | null;
  ready_at: string | null;
  deleted_at: string | null;
  created_at: string;
  dispute_evidence_id: string | null;
  listing_id: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_MEDIA__:
    | {
        objects: Map<string, MockMediaObject>;
        blobs: Map<string, ArrayBuffer>;
      }
    | undefined;
}

if (
  !globalThis.__ROBOTUN_MEDIA__ ||
  !(globalThis.__ROBOTUN_MEDIA__.objects instanceof Map)
) {
  globalThis.__ROBOTUN_MEDIA__ = {
    objects: new Map(),
    blobs: new Map(),
  };
}

const mediaStore = globalThis.__ROBOTUN_MEDIA__;

// ---------------------------------------------------------------------------
// Per-purpose caps (spec CON-002/CON-003).
// ---------------------------------------------------------------------------

const MAX_BYTES_BY_PURPOSE: Record<MediaPurpose, number> = {
  listing_cover: 10 * 1024 * 1024,
  listing_gallery: 10 * 1024 * 1024,
  listing_attachment: 10 * 1024 * 1024,
  kyc_document: 20 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
  dispute_evidence: 10 * 1024 * 1024,
};

const MIME_BY_PURPOSE: Record<MediaPurpose, string[]> = {
  listing_cover: ["image/jpeg", "image/png", "image/webp"],
  listing_gallery: ["image/jpeg", "image/png", "image/webp"],
  listing_attachment: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  kyc_document: ["image/jpeg", "image/png", "application/pdf"],
  avatar: ["image/jpeg", "image/png", "image/webp"],
  dispute_evidence: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};

export const ALLOWED_PURPOSES: ReadonlySet<MediaPurpose> = new Set(
  Object.keys(MAX_BYTES_BY_PURPOSE) as MediaPurpose[]
);

// ---------------------------------------------------------------------------
// PublicMediaMeta — sanitized projection per spec §4.5.4 (no storage_key).
// ---------------------------------------------------------------------------

export type PublicMediaMeta = {
  id: string;
  purpose: MediaPurpose;
  status: MediaStatus;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  confirmed_at: string | null;
  ready_at: string | null;
  created_at: string;
};

function projectMeta(o: MockMediaObject): PublicMediaMeta {
  return {
    id: o.id,
    purpose: o.purpose,
    status: o.status,
    original_filename: o.original_filename,
    mime_type: o.mime_type,
    byte_size: o.byte_size,
    confirmed_at: o.confirmed_at,
    ready_at: o.ready_at,
    created_at: o.created_at,
  };
}

// ---------------------------------------------------------------------------
// Operations.
// ---------------------------------------------------------------------------

export type InitiateResult =
  | {
      ok: true;
      media_id: string;
      method: "POST";
      url: string;
      fields: Record<string, string>;
      expires_at: string;
    }
  | { ok: false; error: "mime_not_allowed"; allowed: string[] }
  | { ok: false; error: "size_exceeded"; max_bytes: number }
  | { ok: false; error: "purpose_invalid" };

export function initiateUpload(params: {
  caller_user_id: string;
  purpose: MediaPurpose;
  mime_type: string;
  byte_size: number;
  original_filename: string;
}): InitiateResult {
  const { caller_user_id, purpose, mime_type, byte_size, original_filename } = params;
  if (!ALLOWED_PURPOSES.has(purpose)) {
    return { ok: false, error: "purpose_invalid" };
  }
  const allowed = MIME_BY_PURPOSE[purpose];
  if (!allowed.includes(mime_type)) {
    return { ok: false, error: "mime_not_allowed", allowed };
  }
  const maxBytes = MAX_BYTES_BY_PURPOSE[purpose];
  if (byte_size <= 0 || byte_size > maxBytes) {
    return { ok: false, error: "size_exceeded", max_bytes: maxBytes };
  }
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  // dispute_evidence per §4.1.2: owner_user_id=NULL; uploader tracked separately.
  // Other purposes will be wired in Step 2/3.
  mediaStore.objects.set(id, {
    id,
    uploader_user_id: caller_user_id,
    owner_user_id: null,
    purpose,
    original_filename: original_filename.slice(0, 256),
    mime_type,
    byte_size,
    status: "awaiting_upload",
    confirmed_at: null,
    ready_at: null,
    deleted_at: null,
    created_at,
    dispute_evidence_id: null,
    listing_id: null,
  });
  return {
    ok: true,
    media_id: id,
    method: "POST",
    url: `/api/v1/media/uploads/${id}/blob`,
    fields: {}, // empty for mock; real backend embeds presigned POST policy/signature
    expires_at,
  };
}

export type StoreBlobResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already_confirmed" | "size_mismatch" };

export function storeBlob(
  media_id: string,
  caller_user_id: string,
  data: ArrayBuffer
): StoreBlobResult {
  const obj = mediaStore.objects.get(media_id);
  if (!obj || obj.uploader_user_id !== caller_user_id || obj.status === "deleted") {
    return { ok: false, error: "not_found" };
  }
  if (obj.status !== "awaiting_upload") {
    return { ok: false, error: "already_confirmed" };
  }
  if (data.byteLength > obj.byte_size + 1024) {
    // SEC-008: content-length-range upper bound is declared_size + 1024
    return { ok: false, error: "size_mismatch" };
  }
  mediaStore.blobs.set(media_id, data);
  return { ok: true };
}

export type ConfirmResult =
  | { ok: true; media: PublicMediaMeta }
  | { ok: false; error: "not_found" | "blob_missing" };

export function confirmUpload(media_id: string, caller_user_id: string): ConfirmResult {
  const obj = mediaStore.objects.get(media_id);
  if (!obj || obj.uploader_user_id !== caller_user_id || obj.status === "deleted") {
    return { ok: false, error: "not_found" };
  }
  if (obj.status === "ready") {
    // Idempotent (spec §4.5.2): return current state.
    return { ok: true, media: projectMeta(obj) };
  }
  if (!mediaStore.blobs.has(media_id)) {
    return { ok: false, error: "blob_missing" };
  }
  const now = new Date().toISOString();
  obj.confirmed_at = now;
  obj.ready_at = now;
  obj.status = "ready";
  // In production: status would flip to 'awaiting_scan' here, ClamAV worker
  // would COPY quarantine → target bucket and promote to 'ready' asynchronously.
  return { ok: true, media: projectMeta(obj) };
}

export type GetMetaResult =
  | { ok: true; media: PublicMediaMeta }
  | { ok: false; error: "not_found" };

export function getMediaMeta(media_id: string, caller_user_id: string): GetMetaResult {
  const obj = mediaStore.objects.get(media_id);
  if (!obj || obj.status === "deleted") return { ok: false, error: "not_found" };
  // dispute_evidence Step 1: uploader-only. (Admin streaming access in Step 2.)
  if (obj.uploader_user_id !== caller_user_id) return { ok: false, error: "not_found" };
  return { ok: true, media: projectMeta(obj) };
}

export type StreamResult =
  | { ok: true; buffer: ArrayBuffer; mime_type: string; filename: string }
  | { ok: false; error: "not_found" | "blob_missing" };

export function streamBlob(
  media_id: string,
  caller_user_id: string | null,
  isAdmin = false
): StreamResult {
  const obj = mediaStore.objects.get(media_id);
  if (!obj || obj.status === "deleted") return { ok: false, error: "not_found" };
  // Per-purpose authorization (spec §4.5.3):
  //  listing_cover/listing_gallery → public iff listing.status='active'; mock
  //    treats them as public regardless (listings in mock are immediately
  //    active). Real backend joins listings.status before serving.
  //  avatar → public.
  //  dispute_evidence / listing_attachment / kyc_document → owner-only
  //    (admin allowed for dispute_evidence; KYC reviewer in Step 3).
  let authorized: boolean;
  if (
    obj.purpose === "listing_cover" ||
    obj.purpose === "listing_gallery" ||
    obj.purpose === "avatar"
  ) {
    authorized = true;
  } else {
    authorized =
      isAdmin ||
      (caller_user_id !== null && obj.uploader_user_id === caller_user_id);
  }
  if (!authorized) return { ok: false, error: "not_found" };
  const buffer = mediaStore.blobs.get(media_id);
  if (!buffer) return { ok: false, error: "blob_missing" };
  return {
    ok: true,
    buffer,
    mime_type: obj.mime_type,
    filename: obj.original_filename,
  };
}

export function softDeleteMedia(media_id: string, caller_user_id: string): boolean {
  const obj = mediaStore.objects.get(media_id);
  if (!obj || obj.uploader_user_id !== caller_user_id || obj.status === "deleted") {
    return false;
  }
  obj.status = "deleted";
  obj.deleted_at = new Date().toISOString();
  mediaStore.blobs.delete(media_id);
  return true;
}

// ---------------------------------------------------------------------------
// Cross-module validators.
// ---------------------------------------------------------------------------

export type AttachmentValidation =
  | { valid: true }
  | { valid: false; invalid_ids: string[] };

export function validateAttachments(
  ids: readonly string[],
  caller_user_id: string,
  expected_purpose: MediaPurpose
): AttachmentValidation {
  const invalid: string[] = [];
  for (const id of ids) {
    const obj = mediaStore.objects.get(id);
    if (
      !obj ||
      obj.uploader_user_id !== caller_user_id ||
      obj.purpose !== expected_purpose ||
      obj.status !== "ready"
    ) {
      invalid.push(id);
    }
  }
  if (invalid.length > 0) return { valid: false, invalid_ids: invalid };
  return { valid: true };
}

export function backfillDisputeEvidenceFk(ids: readonly string[], dispute_evidence_id: string) {
  for (const id of ids) {
    const obj = mediaStore.objects.get(id);
    if (obj) obj.dispute_evidence_id = dispute_evidence_id;
  }
}

/**
 * Validate listing-bound attachments (cover OR gallery purpose accepted).
 * Wired from POST /listings. Mirrors spec §4.1.1 listing media ownership +
 * purpose contract.
 */
export function validateListingAttachments(
  ids: readonly string[],
  caller_user_id: string
): AttachmentValidation {
  const invalid: string[] = [];
  for (const id of ids) {
    const obj = mediaStore.objects.get(id);
    if (
      !obj ||
      obj.uploader_user_id !== caller_user_id ||
      (obj.purpose !== "listing_gallery" && obj.purpose !== "listing_cover") ||
      obj.status !== "ready"
    ) {
      invalid.push(id);
    }
  }
  if (invalid.length > 0) return { valid: false, invalid_ids: invalid };
  return { valid: true };
}

/** Listing-id back-fill on each media row after the listing row is inserted. */
export function backfillListingIdFk(ids: readonly string[], listing_id: string) {
  for (const id of ids) {
    const obj = mediaStore.objects.get(id);
    if (obj) obj.listing_id = listing_id;
  }
}
