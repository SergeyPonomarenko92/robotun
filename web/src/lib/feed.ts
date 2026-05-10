"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";
import type { ListingCardData } from "@/components/organisms/ListingCard";

export type ListingProjection = {
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
  response_time?: string;
  provider: {
    id: string;
    name: string;
    avatar_url?: string;
    kyc_verified: boolean;
    avg_rating: number;
    reviews_count: number;
    completed_deals_count: number;
  };
  feed_base_score: number;
};

export type FeedFilters = {
  category_id?: string | null;
  city?: string | null;
  price_min?: number | null;
  price_max?: number | null;
  min_rating?: number | null;
  kyc_only?: boolean;
  q?: string;
};

type FeedResponse = {
  items: ListingProjection[];
  next_cursor: string | null;
  total_estimate: number;
};

function buildQueryString(filters: FeedFilters, cursor: string | null, limit: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  if (filters.category_id) p.set("category_id", filters.category_id);
  if (filters.city) p.set("city", filters.city);
  if (filters.price_min != null) p.set("price_min", String(filters.price_min));
  if (filters.price_max != null) p.set("price_max", String(filters.price_max));
  if (filters.min_rating != null)
    p.set("min_rating", String(filters.min_rating));
  if (filters.kyc_only) p.set("kyc_only", "true");
  if (filters.q?.trim()) p.set("q", filters.q.trim());
  return p.toString();
}

/** Map server projection → ListingCard component's expected shape. */
export function projectionToCard(p: ListingProjection): ListingCardData {
  return {
    id: p.id,
    href: `/listings/${p.id}`,
    title: p.title,
    coverUrl: p.cover_url,
    priceFromKopecks: p.price_from_kopecks,
    priceUnit: p.price_unit,
    city: p.city,
    region: p.region,
    category: p.category,
    flags: p.flags,
    responseTime: p.response_time,
    provider: {
      name: p.provider.name,
      avatarUrl: p.provider.avatar_url,
      kycVerified: p.provider.kyc_verified,
      avgRating: p.provider.avg_rating,
      reviewsCount: p.provider.reviews_count,
      completedDealsCount: p.provider.completed_deals_count,
    },
  };
}

type FeedState = {
  /** Усі завантажені сторінки, конкатеновані. */
  items: ListingProjection[];
  /** Курсор для loadMore — null якщо більше немає. */
  nextCursor: string | null;
  /** Оцінка загальної кількості після фільтрів (для лічильника). */
  totalEstimate: number;
  loading: boolean;
  loadingMore: boolean;
  error: ApiError | Error | null;
};

const INITIAL: FeedState = {
  items: [],
  nextCursor: null,
  totalEstimate: 0,
  loading: true,
  loadingMore: false,
  error: null,
};

/**
 * Cursor-paginated feed hook. Filter changes → full reset; loadMore → append.
 */
export function useFeed(filters: FeedFilters, limit = 12) {
  const [state, setState] = React.useState<FeedState>(INITIAL);

  // Stabilize filter signature so React effect doesn't fire on every render
  const filterKey = JSON.stringify(filters);

  // Initial / on-filter-change load
  React.useEffect(() => {
    let cancelled = false;
    setState({ ...INITIAL, loading: true });
    (async () => {
      try {
        const qs = buildQueryString(filters, null, limit);
        const data = await apiFetch<FeedResponse>(`/feed?${qs}`);
        if (cancelled) return;
        setState({
          items: data.items,
          nextCursor: data.next_cursor,
          totalEstimate: data.total_estimate,
          loading: false,
          loadingMore: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          items: [],
          nextCursor: null,
          totalEstimate: 0,
          loading: false,
          loadingMore: false,
          error: err as Error,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, limit]);

  const loadMore = React.useCallback(async () => {
    setState((s) => {
      if (s.loading || s.loadingMore || !s.nextCursor) return s;
      return { ...s, loadingMore: true };
    });
    // Read fresh state via setState callback to avoid stale closure
    let cursorAtCall: string | null = null;
    setState((s) => {
      cursorAtCall = s.nextCursor;
      return s;
    });
    if (!cursorAtCall) return;
    try {
      const qs = buildQueryString(filters, cursorAtCall, limit);
      const data = await apiFetch<FeedResponse>(`/feed?${qs}`);
      setState((s) => ({
        items: [...s.items, ...data.items],
        nextCursor: data.next_cursor,
        totalEstimate: data.total_estimate,
        loading: false,
        loadingMore: false,
        error: null,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loadingMore: false, error: err as Error }));
    }
  }, [filterKey, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, loadMore };
}
