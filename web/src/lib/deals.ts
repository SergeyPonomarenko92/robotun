"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type DealStatus =
  | "pending"
  | "active"
  | "in_review"
  | "completed"
  | "disputed"
  | "cancelled";

export type Urgency = "today" | "tomorrow" | "week" | "later";

export type Deal = {
  id: string;
  listing_id: string;
  client_id: string;
  provider_id: string;
  status: DealStatus;
  scope: string;
  urgency: Urgency;
  deadline_at: string | null;
  address: string;
  phone: string;
  attachment_ids: string[];
  budget_kopecks: number;
  fee_kopecks: number;
  total_held_kopecks: number;
  hold_id: string;
  created_at: string;
  listing_title_snapshot: string;
};

export type CreateDealInput = {
  listing_id: string;
  scope: string;
  urgency: Urgency;
  deadline_at?: string | null;
  address: string;
  phone: string;
  budget_kopecks: number;
  attachment_ids?: string[];
  escrow_confirmed: boolean;
  terms_confirmed: boolean;
};

export type CreateDealError = {
  /** Form-level message — show at top of form. */
  message: string;
  /** Per-field codes from server `validation_failed.fields`. */
  fields?: Record<string, string>;
  status: number;
};

/**
 * Submit a deal create. Returns the created deal on success, or a typed
 * error object the form can render. Network errors are normalized to
 * status:0.
 */
export async function createDeal(
  input: CreateDealInput
): Promise<{ ok: true; deal: Deal } | { ok: false; error: CreateDealError }> {
  try {
    const deal = await apiFetch<Deal>("/deals", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { ok: true, deal };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as
        | { error?: string; fields?: Record<string, string> }
        | null;
      const message =
        e.status === 401
          ? "Потрібно увійти, щоб створити угоду"
          : e.status === 422 && body?.error === "cannot_deal_with_self"
            ? "Не можна створити угоду на власну послугу"
            : e.status === 400 && body?.error === "validation_failed"
              ? "Перевірте поля форми"
              : e.status === 404
                ? "Послугу не знайдено або вона недоступна"
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

/* =====================================================================
   useDeal — single-deal viewer hook (used by /deals/:id and similar).
   ===================================================================== */
type DealState = {
  data: Deal | null;
  loading: boolean;
  error: ApiError | Error | null;
  notFound: boolean;
};
const DEAL_INITIAL: DealState = {
  data: null,
  loading: true,
  error: null,
  notFound: false,
};

export function useDeal(id: string | null | undefined): DealState {
  const [state, setState] = React.useState<DealState>(DEAL_INITIAL);

  React.useEffect(() => {
    if (!id) {
      setState({ ...DEAL_INITIAL, loading: false });
      return;
    }
    let cancelled = false;
    setState({ ...DEAL_INITIAL, loading: true });
    (async () => {
      try {
        const data = await apiFetch<Deal>(
          `/deals/${encodeURIComponent(id)}`
        );
        if (!cancelled)
          setState({ data, loading: false, error: null, notFound: false });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ data: null, loading: false, error: null, notFound: true });
        } else {
          setState({
            data: null,
            loading: false,
            error: err as Error,
            notFound: false,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return state;
}
