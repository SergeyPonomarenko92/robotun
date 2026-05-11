"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type Review = {
  id: string;
  rating: number;
  body: string;
  created_at: string;
  author: { display_name: string; avatar_url?: string };
  deal_ref?: string;
  reply?: { body: string; created_at: string };
  status: "published";
};

type State = {
  items: Review[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
};

const INITIAL: State = {
  items: [],
  total: 0,
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
};

/**
 * Paginated reviews for a listing. First fetch is lazy — call `start()` to
 * trigger it (lets the page decide when to load vs. show preview-only).
 */
export function useListingReviews(
  listingId: string | null | undefined,
  options: { limit?: number; rating?: number } = {}
) {
  const { limit = 10, rating } = options;
  const [state, setState] = React.useState<State>(INITIAL);
  const [started, setStarted] = React.useState(false);

  const buildQuery = React.useCallback(
    (cursor?: string | null) => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      if (rating) qs.set("rating", String(rating));
      if (cursor) qs.set("cursor", cursor);
      return qs.toString();
    },
    [limit, rating]
  );

  React.useEffect(() => {
    if (!started || !listingId) return;
    let cancelled = false;
    setState({ ...INITIAL, loading: true });
    (async () => {
      try {
        const data = await apiFetch<{
          items: Review[];
          next_cursor: string | null;
          total: number;
        }>(
          `/listings/${encodeURIComponent(listingId)}/reviews?${buildQuery(null)}`,
          { anonymous: true }
        );
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
        if (err instanceof ApiError && err.status === 404) {
          setState({ ...INITIAL, loading: false });
        } else {
          setState({
            ...INITIAL,
            loading: false,
            error: err as Error,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listingId, buildQuery, started]);

  const loadMore = React.useCallback(async () => {
    if (!listingId) return;
    if (state.loading || state.loadingMore || !state.nextCursor) return;
    setState((s) => ({ ...s, loadingMore: true }));
    try {
      const data = await apiFetch<{
        items: Review[];
        next_cursor: string | null;
        total: number;
      }>(
        `/listings/${encodeURIComponent(listingId)}/reviews?${buildQuery(state.nextCursor)}`,
        { anonymous: true }
      );
      setState((s) => ({
        ...s,
        items: [...s.items, ...data.items],
        nextCursor: data.next_cursor,
        loadingMore: false,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loadingMore: false, error: err as Error }));
    }
  }, [listingId, buildQuery, state.loading, state.loadingMore, state.nextCursor]);

  return { ...state, start: () => setStarted(true), started, loadMore };
}
