"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type AdminListingRow = {
  id: string;
  title: string;
  cover_url: string;
  city: string;
  category: string;
  price_from_kopecks: number;
  price_unit: string;
  provider: {
    id: string;
    name: string;
    avatar_url?: string;
    kyc_verified: boolean;
  };
  archived: boolean;
};

export type AdminListingsFilter = "active" | "archived" | "all";

export function useAdminListings(filter: AdminListingsFilter, q: string) {
  const [items, setItems] = React.useState<AdminListingRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    setError(null);
    setItems(null);
    const p = new URLSearchParams();
    if (filter === "active") p.set("archived", "false");
    if (filter === "archived") p.set("archived", "true");
    if (q) p.set("q", q);
    const qs = p.toString();
    apiFetch<{ items: AdminListingRow[] }>(
      "/admin/listings" + (qs ? `?${qs}` : "")
    )
      .then((r) => setItems(r.items))
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "network_error");
        setItems([]);
      });
  }, [filter, q]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, error, refresh };
}

export type ModerationError = { message: string; status: number };

async function callMutation(
  path: string,
  reason: string
): Promise<{ ok: true } | { ok: false; error: ModerationError }> {
  try {
    await apiFetch(path, { method: "POST", body: JSON.stringify({ reason }) });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const code = body?.error ?? "unknown";
      const message =
        code === "reason_too_short"
          ? "Причина має містити мінімум 10 символів"
          : code === "already_archived"
            ? "Лот вже архівовано"
            : code === "not_archived"
              ? "Лот не архівовано"
              : code === "not_found"
                ? "Лот не знайдено"
                : e.message;
      return { ok: false, error: { message, status: e.status } };
    }
    return { ok: false, error: { message: "Немає з'єднання", status: 0 } };
  }
}

export function archiveListingApi(id: string, reason: string) {
  return callMutation(
    `/admin/listings/${encodeURIComponent(id)}/archive`,
    reason
  );
}

export function reinstateListingApi(id: string, reason: string) {
  return callMutation(
    `/admin/listings/${encodeURIComponent(id)}/reinstate`,
    reason
  );
}
