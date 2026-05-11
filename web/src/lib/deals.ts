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

export type DealParty = {
  id: string;
  display_name: string;
  avatar_url?: string;
  kyc_verified: boolean;
};

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
  cancel_requested_by_client_at: string | null;
  cancel_requested_by_provider_at: string | null;
  cancel_request_reason: string | null;
  dispute_evidence_client: DealEvidence | null;
  dispute_evidence_provider: DealEvidence | null;
  dispute_evidence_visibility: "open" | "redacted" | "revealed";
  dispute_resolution: DealResolution | null;
  client: DealParty;
  provider: DealParty;
};

export type DisputeReason =
  | "not_delivered"
  | "partial_work"
  | "wrong_quality"
  | "out_of_scope"
  | "client_withdrew"
  | "other";

export type DealEvidence = {
  reason: DisputeReason;
  statement: string;
  attachment_ids: string[];
  submitted_at: string;
};

export type DealResolution = {
  verdict: "refund_client" | "release_to_provider";
  resolver_admin_id: string;
  reason: string;
  resolved_at: string;
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

/* =====================================================================
   useMyDeals — list hook for the caller's own deals (provider-dashboard,
   client "my deals" view). Wraps GET /users/me/deals with role + status
   filters and cursor pagination.
   ===================================================================== */
export type MyDealsFilters = {
  role?: "client" | "provider" | "any";
  status?: DealStatus[];
  limit?: number;
};

type MyDealsState = {
  items: Deal[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
};

const MY_DEALS_INITIAL: MyDealsState = {
  items: [],
  total: 0,
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
};

export function useMyDeals(filters: MyDealsFilters = {}) {
  const { role = "any", status, limit = 20 } = filters;
  const statusKey = status?.slice().sort().join(",") ?? "";
  const [state, setState] = React.useState<MyDealsState>(MY_DEALS_INITIAL);
  const [refreshTick, setRefreshTick] = React.useState(0);

  const buildQuery = React.useCallback(
    (cursor?: string | null) => {
      const qs = new URLSearchParams();
      if (role && role !== "any") qs.set("role", role);
      if (status && status.length) qs.set("status", status.join(","));
      qs.set("limit", String(limit));
      if (cursor) qs.set("cursor", cursor);
      return qs.toString();
    },
    [role, statusKey, limit] // eslint-disable-line react-hooks/exhaustive-deps
  );

  React.useEffect(() => {
    let cancelled = false;
    setState(MY_DEALS_INITIAL);
    (async () => {
      try {
        const data = await apiFetch<{
          items: Deal[];
          next_cursor: string | null;
          total: number;
        }>(`/users/me/deals?${buildQuery(null)}`);
        if (cancelled) return;
        setState({
          items: data.items,
          total: data.total,
          nextCursor: data.next_cursor,
          loading: false,
          loadingMore: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          items: [],
          total: 0,
          nextCursor: null,
          loading: false,
          loadingMore: false,
          error: err as Error,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildQuery, refreshTick]);

  const loadMore = React.useCallback(async () => {
    setState((s) =>
      s.loading || s.loadingMore || !s.nextCursor
        ? s
        : { ...s, loadingMore: true }
    );
    try {
      const cursor = state.nextCursor;
      if (!cursor) return;
      const data = await apiFetch<{
        items: Deal[];
        next_cursor: string | null;
        total: number;
      }>(`/users/me/deals?${buildQuery(cursor)}`);
      setState((s) => ({
        ...s,
        items: [...s.items, ...data.items],
        nextCursor: data.next_cursor,
        loadingMore: false,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loadingMore: false, error: err as Error }));
    }
  }, [buildQuery, state.nextCursor]);

  const refresh = React.useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  return { ...state, loadMore, refresh };
}

/* =====================================================================
   State transition actions — wraps POST /deals/:id/transition.
   ===================================================================== */
export type DealAction =
  | "accept"
  | "reject"
  | "cancel"
  | "submit"
  | "approve"
  | "dispute";

/* =====================================================================
   Mutual cancel handshake — POST /deals/:id/cancel-request.
   ===================================================================== */
export type CancelRequestAction = "request" | "revoke";

export async function cancelRequest(
  id: string,
  action: CancelRequestAction,
  reason?: string
): Promise<
  { ok: true; deal: Deal } | { ok: false; error: { message: string; status: number } }
> {
  try {
    const deal = await apiFetch<Deal>(
      `/deals/${encodeURIComponent(id)}/cancel-request`,
      {
        method: "POST",
        body: JSON.stringify({ action, reason }),
      }
    );
    return { ok: true, deal };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const code = body?.error;
      const message =
        e.status === 401
          ? "Потрібно увійти знову"
          : e.status === 403
            ? "Ви не сторона цієї угоди"
            : e.status === 404
              ? "Угоду не знайдено"
              : code === "no_active_request"
                ? "Запит вже скасовано"
                : code === "invalid_state"
                  ? "Скасування можливе тільки під час виконання угоди"
                  : "Сервіс тимчасово недоступний";
      return { ok: false, error: { message, status: e.status } };
    }
    return {
      ok: false,
      error: { message: "Не вдалось підключитись", status: 0 },
    };
  }
}

/* =====================================================================
   Module 14 — dispute evidence + admin resolution.
   ===================================================================== */

export type SubmitEvidenceInput = {
  reason: DisputeReason;
  statement: string;
  attachment_ids?: string[];
};

export type SubmitEvidenceError = {
  message: string;
  fields?: Record<string, string>;
  status: number;
};

export async function submitDisputeEvidence(
  dealId: string,
  input: SubmitEvidenceInput
): Promise<
  | { ok: true; deal: Deal }
  | { ok: false; error: SubmitEvidenceError }
> {
  try {
    const deal = await apiFetch<Deal>(
      `/deals/${encodeURIComponent(dealId)}/dispute-evidence`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return { ok: true, deal };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as
        | { error?: string; fields?: Record<string, string> }
        | null;
      const code = body?.error;
      const message =
        e.status === 401
          ? "Потрібно увійти знову"
          : e.status === 403
            ? "Ви не сторона цієї угоди"
            : e.status === 404
              ? "Угоду не знайдено"
              : code === "already_submitted"
                ? "Ви вже надіслали свої свідчення"
                : code === "invalid_state"
                  ? "Угода не у стані диспуту"
                  : code === "validation_failed"
                    ? "Перевірте поля форми"
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

export type ResolveDisputeInput = {
  verdict: "refund_client" | "release_to_provider";
  reason: string;
};

export async function resolveDispute(
  dealId: string,
  input: ResolveDisputeInput
): Promise<
  { ok: true; deal: Deal } | { ok: false; error: { message: string; status: number } }
> {
  try {
    const deal = await apiFetch<Deal>(
      `/admin/disputes/${encodeURIComponent(dealId)}/resolve`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return { ok: true, deal };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const message =
        e.status === 401
          ? "Потрібно увійти знову"
          : e.status === 403
            ? "Лише адміністратор може закривати диспут"
            : e.status === 404
              ? "Угоду не знайдено"
              : body?.error === "validation_failed"
                ? "Перевірте поля форми"
                : body?.error === "invalid_state"
                  ? "Угода вже не в диспуті"
                  : "Сервіс тимчасово недоступний";
      return { ok: false, error: { message, status: e.status } };
    }
    return {
      ok: false,
      error: { message: "Не вдалось підключитись", status: 0 },
    };
  }
}

/** Admin queue list. */
export function useDisputedDeals() {
  const [state, setState] = React.useState<{
    items: Deal[];
    total: number;
    loading: boolean;
    error: Error | null;
  }>({ items: [], total: 0, loading: true, error: null });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    apiFetch<{ items: Deal[]; total: number }>("/admin/disputes")
      .then((d) => {
        if (!cancelled)
          setState({ items: d.items, total: d.total, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled)
          setState({ items: [], total: 0, loading: false, error: err as Error });
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { ...state, refresh: () => setTick((t) => t + 1) };
}

export async function transitionDeal(
  id: string,
  action: DealAction
): Promise<{ ok: true; deal: Deal } | { ok: false; error: { message: string; status: number } }> {
  try {
    const deal = await apiFetch<Deal>(
      `/deals/${encodeURIComponent(id)}/transition`,
      {
        method: "POST",
        body: JSON.stringify({ action }),
      }
    );
    return { ok: true, deal };
  } catch (e) {
    if (e instanceof ApiError) {
      const message =
        e.status === 401
          ? "Потрібно увійти знову"
          : e.status === 403
            ? "Цю дію може виконати лише інша сторона угоди"
            : e.status === 409
              ? "Стан угоди не дозволяє цю дію — оновіть сторінку"
              : e.status === 404
                ? "Угоду не знайдено"
                : "Сервіс тимчасово недоступний";
      return { ok: false, error: { message, status: e.status } };
    }
    return {
      ok: false,
      error: { message: "Не вдалось підключитись", status: 0 },
    };
  }
}
