"use client";
import * as React from "react";
import type { Category } from "@/components/ui/CategoryPicker";
import { apiFetch } from "./api";

export type CategoryTreeState = {
  data: Category[] | null;
  loading: boolean;
  error: Error | null;
};

const INITIAL: CategoryTreeState = {
  data: null,
  loading: true,
  error: null,
};

let _cache: Category[] | null = null;
let _inflight: Promise<Category[]> | null = null;

async function fetchTree(): Promise<Category[]> {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const data = await apiFetch<{ items: Category[] }>("/categories", {
      anonymous: true,
    });
    _cache = data.items;
    _inflight = null;
    return data.items;
  })();
  return _inflight;
}

/**
 * Fetch and cache the 3-level category tree. Public endpoint so anonymous.
 * Cached module-globally — every call after the first returns synchronously
 * via the cached promise resolution.
 */
export function useCategories(): CategoryTreeState {
  const [state, setState] = React.useState<CategoryTreeState>(() =>
    _cache ? { data: _cache, loading: false, error: null } : INITIAL
  );

  React.useEffect(() => {
    if (_cache) return;
    let cancelled = false;
    fetchTree()
      .then((items) => {
        if (!cancelled) setState({ data: items, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled)
          setState({ data: null, loading: false, error: err as Error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
