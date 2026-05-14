"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type NotificationAggregateType =
  | "deal"
  | "review"
  | "user"
  | "message"
  | "conversation"
  | "payment"
  | "payout"
  | "refund"
  | "chargeback"
  | "wallet";

export type Notification = {
  id: string;
  user_id: string;
  notification_code: string;
  aggregate_type: NotificationAggregateType;
  aggregate_id: string | null;
  title: string;
  body: string | null;
  href: string | null;
  mandatory: boolean;
  read_at: string | null;
  created_at: string;
};

export function useNotifications() {
  const [items, setItems] = React.useState<Notification[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);
  const refresh = React.useCallback(() => {
    apiFetch<{ items: Notification[]; next_cursor: string | null }>(
      "/me/notifications?limit=50"
    )
      .then((r) => mountedRef.current && setItems(r.items))
      .catch((e) => {
        if (!mountedRef.current) return;
        setError(e instanceof ApiError ? e.message : "network_error");
        setItems([]);
      });
  }, []);
  React.useEffect(() => {
    refresh();
  }, [refresh]);
  return { items, error, refresh };
}

const POLL_MS = 10_000;

/** Lightweight badge-count hook polled every 10s. Used by TopNav. */
export function useNotificationsUnreadCount(enabled: boolean) {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const fetchOnce = () => {
      apiFetch<{ count: number }>("/me/notifications/unread-count")
        .then((r) => alive && setCount(r.count))
        .catch(() => {
          // silent — badge collapses to 0 on auth/network blip
        });
    };
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return count;
}

export async function markRead(id: string) {
  return apiFetch(
    `/me/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" }
  );
}

export async function markAllRead() {
  return apiFetch("/me/notifications/read-all", { method: "POST" });
}
