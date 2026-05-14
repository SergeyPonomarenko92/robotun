"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";
import type { MfaChallenge } from "./deals";

export type AdminUserStatus = "active" | "pending" | "suspended" | "deleted";
export type AdminUserRole = "client" | "provider" | "admin" | "moderator" | "support";

export type AdminUserListItem = {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  status: AdminUserStatus;
  roles: AdminUserRole[];
  kyc_status: string;
  created_at: string;
};

export type AdminUserDetail = AdminUserListItem & {
  email_verified: boolean;
  mfa_enrolled: boolean;
  payout_enabled: boolean;
  has_provider_role: boolean;
  wallet: {
    available_kopecks: number;
    held_kopecks: number;
    pending_payout_kopecks: number;
  } | null;
  deal_counters: {
    as_client: number;
    as_provider: number;
    active: number;
    disputed: number;
  };
  recent_admin_actions: {
    id: string;
    action: string;
    created_at: string;
    actor_admin_id: string;
    metadata: Record<string, unknown>;
  }[];
};

export type ListUsersFilters = {
  q?: string;
  status?: AdminUserStatus | null;
  role?: AdminUserRole | null;
};

export function useAdminUsers(filters: ListUsersFilters) {
  const [items, setItems] = React.useState<AdminUserListItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const filtersKey = JSON.stringify(filters);
  const refresh = React.useCallback(() => {
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.status) p.set("status", filters.status);
    if (filters.role) p.set("role", filters.role);
    const qs = p.toString();
    setError(null);
    setItems(null);
    apiFetch<{ items: AdminUserListItem[] }>(
      "/admin/users" + (qs ? `?${qs}` : "")
    )
      .then((r) => setItems(r.items))
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "network_error");
        setItems([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);
  React.useEffect(() => {
    refresh();
  }, [refresh]);
  return { items, error, refresh };
}

// ---------------------------------------------------------------------------
// Suspend / unsuspend (Module 12 §4.7 + ADM-SEC-006).
// ---------------------------------------------------------------------------

export type SuspendInput = {
  reason: string;
  mfa_challenge_id: string;
  mfa_code: string;
};

export type SuspendError = {
  message: string;
  status: number;
  /** Distinguishes which step failed so the modal can route back: MFA error
   *  → step 1 (reissue), validation → step 0 (reason). */
  step?: "reason" | "mfa";
};

async function callMutation(
  path: string,
  input: SuspendInput
): Promise<
  | { ok: true; status: AdminUserStatus }
  | { ok: false; error: SuspendError }
> {
  try {
    const r = await apiFetch<{ id: string; status: AdminUserStatus }>(path, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { ok: true, status: r.status };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const code = body?.error ?? "unknown";
      // MFA errors → step:'mfa'; reason / state errors → step:'reason'.
      const mfaErrors = new Set([
        "mfa_missing",
        "mfa_not_found",
        "mfa_expired",
        "mfa_consumed",
        "mfa_wrong_admin",
        "mfa_code_invalid",
      ]);
      const step: SuspendError["step"] = mfaErrors.has(code) ? "mfa" : "reason";
      const message =
        code === "reason_too_short"
          ? "Причина має містити мінімум 10 символів"
          : code === "cannot_suspend_self"
            ? "Не можна зупинити власний обліковий запис"
            : code === "already_suspended"
              ? "Користувача вже зупинено"
              : code === "not_suspended"
                ? "Користувач не зупинений"
                : code === "user_deleted"
                  ? "Користувач видалений — дія недоступна"
                  : mfaErrors.has(code)
                    ? "Невірний або застарілий код MFA — потрібен новий"
                    : e.message;
      return { ok: false, error: { message, status: e.status, step } };
    }
    return {
      ok: false,
      error: { message: "Немає з'єднання", status: 0 },
    };
  }
}

export function suspendUser(userId: string, input: SuspendInput) {
  return callMutation(
    `/admin/users/${encodeURIComponent(userId)}/suspend`,
    input
  );
}

export function unsuspendUser(userId: string, input: SuspendInput) {
  return callMutation(
    `/admin/users/${encodeURIComponent(userId)}/unsuspend`,
    input
  );
}

export type { MfaChallenge };

export function useAdminUser(id: string | null) {
  const [data, setData] = React.useState<AdminUserDetail | null>(null);
  const [error, setError] = React.useState<{ status: number; message: string } | null>(null);
  const refresh = React.useCallback(() => {
    if (!id) return;
    setError(null);
    setData(null);
    apiFetch<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError) {
          setError({ status: e.status, message: e.message });
        } else {
          setError({ status: 0, message: "network_error" });
        }
      });
  }, [id]);
  React.useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, error, refresh };
}
