"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type Payout = {
  id: string;
  user_id: string;
  amount_kopecks: number;
  status: "requested" | "processing" | "paid" | "failed";
  method_last4: string;
  created_at: string;
  paid_at: string | null;
};

export type PayoutError = {
  message: string;
  code:
    | "amount_invalid"
    | "amount_below_min"
    | "insufficient_funds"
    | "kyc_not_approved"
    | "payout_disabled"
    | "network"
    | "unknown";
  status: number;
};

export type AdminPayoutRow = Payout & {
  payee: { id: string; display_name: string; avatar_url?: string };
};

export function useAdminPayouts() {
  const [state, setState] = React.useState<{
    items: AdminPayoutRow[];
    total: number;
    loading: boolean;
    error: Error | null;
  }>({ items: [], total: 0, loading: true, error: null });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    apiFetch<{ items: AdminPayoutRow[]; total: number }>("/admin/payouts")
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

export async function completePayout(
  payoutId: string,
  mfa: { mfa_challenge_id: string; mfa_code: string }
): Promise<
  | { ok: true; payout: Payout }
  | { ok: false; error: { message: string; status: number; code?: string } }
> {
  try {
    const payout = await apiFetch<Payout>(
      `/admin/payouts/${encodeURIComponent(payoutId)}/complete`,
      { method: "POST", body: JSON.stringify(mfa) }
    );
    return { ok: true, payout };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const code = body?.error;
      const mfaCopy: Record<string, string> = {
        mfa_missing: "Спочатку отримайте код підтвердження",
        mfa_not_found: "Код підтвердження не знайдено",
        mfa_expired: "Код підтвердження прострочений",
        mfa_consumed: "Код вже використано",
        mfa_wrong_admin: "Код не належить вашій сесії",
        mfa_code_invalid: "Невірний код підтвердження",
      };
      const message =
        e.status === 403 && code && code in mfaCopy
          ? mfaCopy[code]
          : e.status === 403
            ? "Лише адміністратор може закривати виплати"
            : code === "already_paid"
              ? "Виплату вже зараховано"
              : code === "failed_terminal"
                ? "Виплата у фінальному стані «помилка», її не можна закрити"
                : e.status === 404
                  ? "Виплату не знайдено"
                  : "Сервіс тимчасово недоступний";
      return { ok: false, error: { message, status: e.status, code } };
    }
    return {
      ok: false,
      error: { message: "Не вдалось підключитись", status: 0 },
    };
  }
}

export async function requestPayout(
  amountKopecks: number
): Promise<{ ok: true; payout: Payout } | { ok: false; error: PayoutError }> {
  try {
    const payout = await apiFetch<Payout>("/payouts", {
      method: "POST",
      body: JSON.stringify({ amount_kopecks: amountKopecks }),
    });
    return { ok: true, payout };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const code = (body?.error ?? "unknown") as PayoutError["code"];
      const message =
        code === "amount_below_min"
          ? "Мінімальна сума виплати — 50 ₴"
          : code === "amount_invalid"
            ? "Невірна сума"
            : code === "insufficient_funds"
              ? "Недостатньо доступних коштів"
              : code === "kyc_not_approved"
                ? "Спочатку пройдіть верифікацію KYC"
                : code === "payout_disabled"
                  ? "Виплати для вашого облікового запису вимкнено"
                  : e.status === 401
                    ? "Потрібно увійти знову"
                    : "Сервіс тимчасово недоступний";
      return { ok: false, error: { message, code, status: e.status } };
    }
    return {
      ok: false,
      error: { message: "Не вдалось підключитись", code: "network", status: 0 },
    };
  }
}

export type WalletBalance = {
  available_kopecks: number;
  held_kopecks: number;
  pending_payout_kopecks: number;
};

export type LedgerKind =
  | "hold"
  | "capture"
  | "fee"
  | "refund"
  | "payout_request"
  | "payout_paid";

export type Transaction = {
  id: string;
  user_id: string;
  bucket: "held" | "available" | "pending_payout";
  amount_kopecks: number;
  kind: LedgerKind;
  created_at: string;
  deal_id?: string;
  payout_id?: string;
  memo: string;
};

/** Single-fetch wallet hook. Re-runs only when `refreshTick` changes. */
export function useWallet(): {
  data: WalletBalance | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const [state, setState] = React.useState<{
    data: WalletBalance | null;
    loading: boolean;
    error: Error | null;
  }>({ data: null, loading: true, error: null });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    apiFetch<WalletBalance>("/users/me/wallet")
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ data: null, loading: false, error: err });
        } else {
          setState({ data: null, loading: false, error: err as Error });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { ...state, refresh: () => setTick((t) => t + 1) };
}

/** Recent operations list with cursor pagination. */
export function useTransactions(opts: { limit?: number } = {}) {
  const { limit = 10 } = opts;
  const [state, setState] = React.useState<{
    items: Transaction[];
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
    apiFetch<{
      items: Transaction[];
      next_cursor: string | null;
      total: number;
    }>(`/users/me/transactions?limit=${limit}`)
      .then((data) => {
        if (cancelled) return;
        setState({
          items: data.items,
          total: data.total,
          nextCursor: data.next_cursor,
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
  }, [limit, tick]);

  const loadMore = React.useCallback(async () => {
    setState((s) =>
      s.loading || s.loadingMore || !s.nextCursor
        ? s
        : { ...s, loadingMore: true }
    );
    try {
      const data = await apiFetch<{
        items: Transaction[];
        next_cursor: string | null;
        total: number;
      }>(`/users/me/transactions?limit=${limit}&cursor=${encodeURIComponent(state.nextCursor!)}`);
      setState((s) => ({
        ...s,
        items: [...s.items, ...data.items],
        nextCursor: data.next_cursor,
        loadingMore: false,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loadingMore: false, error: err as Error }));
    }
  }, [limit, state.nextCursor]);

  return { ...state, loadMore, refresh: () => setTick((t) => t + 1) };
}
