/**
 * Listing-draft store (Module 5 §4.5 draft phase).
 *
 * Per-user persistent partial state for /provider/listings/new wizard. The
 * wizard creates a draft on first edit, debounce-PATCHes it as the user
 * types, and DELETEs it on successful publish (or via dashboard "Видалити").
 *
 * Real backend: separate `listing_drafts` table with TTL (drop after N days
 * untouched) and per-user cap. Mock keeps it on globalThis with an in-memory
 * cap of MAX_PER_USER drafts; oldest auto-evicted on insert beyond cap.
 */

export type DraftPayload = {
  title?: string | null;
  description?: string | null;
  category_path?: {
    l1?: { id: string; name: string };
    l2?: { id: string; name: string };
    l3?: { id: string; name: string };
  };
  city?: string | null;
  region?: string | null;
  tags?: string[];
  pricing_type?: "visit" | "hour" | "project" | "from";
  price_amount_kopecks?: number | null;
  escrow_deposit?: boolean;
  response_sla_minutes?: number;
  // Gallery references — IDs of media objects already uploaded; the wizard
  // is responsible for re-binding these after hydration.
  gallery_media_ids?: string[];
  cover_media_id?: string | null;
};

export type DraftRow = {
  id: string;
  owner_user_id: string;
  payload: DraftPayload;
  created_at: string;
  updated_at: string;
};

const MAX_PER_USER = 5;

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_LISTING_DRAFTS__: Map<string, DraftRow> | undefined;
}
function db(): Map<string, DraftRow> {
  if (!globalThis.__ROBOTUN_LISTING_DRAFTS__) {
    globalThis.__ROBOTUN_LISTING_DRAFTS__ = new Map();
  }
  return globalThis.__ROBOTUN_LISTING_DRAFTS__;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

export type EvictedDraft = {
  id: string;
  title: string;
};

export type CreateDraftResult = {
  draft: DraftRow;
  evicted: EvictedDraft[];
};

export function createDraft(ownerUserId: string): CreateDraftResult {
  const now = new Date().toISOString();
  const row: DraftRow = {
    id: uuid(),
    owner_user_id: ownerUserId,
    payload: {},
    created_at: now,
    updated_at: now,
  };
  db().set(row.id, row);
  // Evict oldest once cap exceeded — surface the loss to the caller so the
  // UI can toast "Найстарішу чернетку «X» було видалено" instead of silent
  // data loss (deep-review MEDIUM від 7dbb64e).
  const evicted: EvictedDraft[] = [];
  const owned = listDraftsForUser(ownerUserId);
  while (owned.length > MAX_PER_USER) {
    const oldest = owned.pop();
    if (!oldest) break;
    db().delete(oldest.id);
    evicted.push({
      id: oldest.id,
      title: oldest.payload.title?.trim() || "Без назви",
    });
  }
  return { draft: row, evicted };
}

export type PatchResult =
  | { ok: true; draft: DraftRow }
  | { ok: false; error: "not_found" | "forbidden" };

export function patchDraft(
  draftId: string,
  callerUserId: string,
  patch: DraftPayload
): PatchResult {
  const row = db().get(draftId);
  if (!row) return { ok: false, error: "not_found" };
  if (row.owner_user_id !== callerUserId) return { ok: false, error: "forbidden" };
  // Shallow merge — wizard always sends the full snapshot it considers
  // authoritative, so this keeps the contract simple.
  row.payload = { ...row.payload, ...patch };
  row.updated_at = new Date().toISOString();
  return { ok: true, draft: row };
}

export function getDraft(
  draftId: string,
  callerUserId: string
): PatchResult {
  const row = db().get(draftId);
  if (!row) return { ok: false, error: "not_found" };
  if (row.owner_user_id !== callerUserId) return { ok: false, error: "forbidden" };
  return { ok: true, draft: row };
}

export function deleteDraft(
  draftId: string,
  callerUserId: string
): { ok: true } | { ok: false; error: "not_found" | "forbidden" } {
  const row = db().get(draftId);
  if (!row) return { ok: false, error: "not_found" };
  if (row.owner_user_id !== callerUserId) return { ok: false, error: "forbidden" };
  db().delete(draftId);
  return { ok: true };
}

export function listDraftsForUser(ownerUserId: string): DraftRow[] {
  const out: DraftRow[] = [];
  for (const row of db().values()) {
    if (row.owner_user_id === ownerUserId) out.push(row);
  }
  // Newest first by updated_at.
  out.sort(
    (a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  return out;
}
