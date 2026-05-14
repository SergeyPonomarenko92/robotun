"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type PricingType = "visit" | "hour" | "project" | "from";

export type CreateListingInput = {
  title: string;
  description: string;
  category_id: string;
  category_path?: {
    l1?: { id: string; name: string };
    l2?: { id: string; name: string };
    l3?: { id: string; name: string };
  };
  city: string;
  region?: string;
  tags?: string[];
  pricing_type: PricingType;
  price_amount_kopecks: number;
  escrow_deposit?: boolean;
  response_sla_minutes?: number;
  gallery: { media_id: string; alt?: string; is_cover?: boolean }[];
  /** When publishing from a draft, pass its id — server deletes atomically. */
  draft_id?: string;
};

export type ListingDetail = {
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
  description: string;
  provider: {
    id: string;
    name: string;
    avatar_url?: string;
    kyc_verified: boolean;
    avg_rating: number;
    reviews_count: number;
    completed_deals_count: number;
  };
  published_at: string;
};

export type CreateListingError = {
  message: string;
  /** Per-field codes from server `validation_failed.fields`. Keys mirror
   *  the request shape so the form can map them to local field names. */
  fields?: Record<string, string>;
  status: number;
};

export async function createListing(
  input: CreateListingInput
): Promise<
  { ok: true; listing: ListingDetail } | { ok: false; error: CreateListingError }
> {
  try {
    const listing = await apiFetch<ListingDetail>("/listings", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { ok: true, listing };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as
        | { error?: string; fields?: Record<string, string> }
        | null;
      const message =
        e.status === 401
          ? "Потрібно увійти, щоб опублікувати послугу"
          : e.status === 400 && body?.error === "validation_failed"
            ? "Перевірте поля форми"
            : e.status === 403
              ? "У вашого облікового запису немає права публікації"
              : e.status === 409
                ? "Перевищено ліміт активних послуг"
                : "Сервіс тимчасово недоступний";
      return {
        ok: false,
        error: { message, fields: body?.fields, status: e.status },
      };
    }
    return {
      ok: false,
      error: { message: "Не вдалось підключитись", status: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// Listing-draft autosave (Module 5 §4.5 draft phase).
// ---------------------------------------------------------------------------

export type DraftPayload = {
  // null = explicit clear (the wizard distinguishes "user emptied input"
  // from "field not touched yet"); undefined / omitted = leave server value.
  title?: string | null;
  description?: string | null;
  category_path?: CreateListingInput["category_path"];
  city?: string | null;
  region?: string | null;
  tags?: string[];
  pricing_type?: PricingType;
  price_amount_kopecks?: number | null;
  escrow_deposit?: boolean;
  response_sla_minutes?: number;
  gallery_media_ids?: string[];
  cover_media_id?: string | null;
};

export type Draft = {
  id: string;
  owner_user_id: string;
  payload: DraftPayload;
  created_at: string;
  updated_at: string;
};

export type EvictedDraftRef = { id: string; title: string };

export type CreateDraftResponse = Draft & { evicted: EvictedDraftRef[] };

export async function createDraft(): Promise<CreateDraftResponse> {
  return apiFetch<CreateDraftResponse>("/listings/drafts", { method: "POST" });
}

export async function patchDraft(id: string, payload: DraftPayload): Promise<Draft> {
  return apiFetch<Draft>(`/listings/drafts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function getDraft(id: string): Promise<Draft> {
  return apiFetch<Draft>(`/listings/drafts/${encodeURIComponent(id)}`);
}

export async function deleteDraft(id: string): Promise<void> {
  await apiFetch(`/listings/drafts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function listDrafts(): Promise<Draft[]> {
  const r = await apiFetch<{ items: Draft[] }>("/listings/drafts");
  return r.items;
}

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string };

/**
 * Debounced autosave loop. Whenever `payload` changes, schedule a PATCH
 * after `debounceMs`. Coalesces multiple changes within the window into a
 * single request. Tracks save status for the UI indicator.
 *
 * Caller is responsible for creating the draft (createDraft) and passing
 * its id; this hook is intentionally id-agnostic so the wizard can defer
 * draft creation until the first edit.
 */
export function useDraftAutosave(opts: {
  draftId: string | null;
  payload: DraftPayload;
  enabled: boolean;
  debounceMs?: number;
}): SaveStatus {
  const { draftId, payload, enabled, debounceMs = 1500 } = opts;
  const [status, setStatus] = React.useState<SaveStatus>({ kind: "idle" });
  const lastSentRef = React.useRef<string>("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = React.useRef(false);
  const pendingRef = React.useRef<DraftPayload | null>(null);
  const mountedRef = React.useRef(true);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingRef.current = null;
      // Abort any in-flight PATCH so a late response cannot resurrect a
      // deleted draft on the server (or write to an unmounted component).
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  React.useEffect(() => {
    if (!enabled || !draftId) return;
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (inFlightRef.current) {
        pendingRef.current = payload;
        return;
      }
      const send = async (snapshot: DraftPayload) => {
        inFlightRef.current = true;
        if (mountedRef.current) setStatus({ kind: "saving" });
        try {
          // patchDraft doesn't currently take a signal — we keep the abort
          // controller anyway to skip post-resolve setState if cancelled.
          abortRef.current = new AbortController();
          const draft = await patchDraft(draftId, snapshot);
          if (!mountedRef.current || abortRef.current.signal.aborted) return;
          lastSentRef.current = JSON.stringify(snapshot);
          setStatus({ kind: "saved", at: draft.updated_at });
        } catch (e) {
          if (!mountedRef.current) return;
          const message =
            e instanceof ApiError
              ? e.status === 404
                ? "Чернетку видалено"
                : e.status === 403
                  ? "Немає прав на цю чернетку"
                  : "Помилка збереження"
              : "Немає з'єднання";
          setStatus({ kind: "error", message });
        } finally {
          inFlightRef.current = false;
          if (mountedRef.current && pendingRef.current) {
            const next = pendingRef.current;
            pendingRef.current = null;
            void send(next);
          }
        }
      };
      void send(payload);
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [draftId, enabled, debounceMs, payload]);

  return status;
}
