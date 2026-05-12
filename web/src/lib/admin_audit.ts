"use client";
import * as React from "react";
import { apiFetch } from "./api";

export type AdminAction = {
  id: string;
  actor_admin_id: string;
  action:
    | "mfa.challenge.issued"
    | "mfa.challenge.consumed"
    | "dispute.resolved"
    | "payout.completed"
    | "kyc.document_streamed";
  target_type: "deal" | "user" | "payout" | "media" | null;
  target_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
};

export function useAdminAudit(opts: {
  limit?: number;
  actionPrefix?: string;
} = {}) {
  const { limit = 20, actionPrefix } = opts;
  const [state, setState] = React.useState<{
    items: AdminAction[];
    total: number;
    nextCursor: string | null;
    loading: boolean;
    loadingMore: boolean;
    error: Error | null;
  }>({
    items: [],
    total: 0,
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
  });
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const qs = new URLSearchParams();
    qs.set("limit", String(limit));
    if (actionPrefix) qs.set("action_prefix", actionPrefix);
    apiFetch<{
      items: AdminAction[];
      next_cursor: string | null;
      total: number;
    }>(`/admin/audit?${qs.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setState({
          items: d.items,
          total: d.total,
          nextCursor: d.next_cursor,
          loading: false,
          loadingMore: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          items: [],
          total: 0,
          nextCursor: null,
          loading: false,
          loadingMore: false,
          error: err as Error,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [limit, actionPrefix, tick]);

  const loadMore = React.useCallback(async () => {
    if (state.loading || state.loadingMore || !state.nextCursor) return;
    setState((s) => ({ ...s, loadingMore: true }));
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      if (actionPrefix) qs.set("action_prefix", actionPrefix);
      qs.set("cursor", state.nextCursor!);
      const d = await apiFetch<{
        items: AdminAction[];
        next_cursor: string | null;
        total: number;
      }>(`/admin/audit?${qs.toString()}`);
      setState((s) => ({
        ...s,
        items: [...s.items, ...d.items],
        nextCursor: d.next_cursor,
        loadingMore: false,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loadingMore: false, error: err as Error }));
    }
  }, [limit, actionPrefix, state.loading, state.loadingMore, state.nextCursor]);

  return { ...state, loadMore, refresh: () => setTick((t) => t + 1) };
}
