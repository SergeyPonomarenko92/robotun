"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type AdminKycRow = {
  provider_id: string;
  provider: {
    id: string;
    display_name: string;
    email: string;
    avatar_url?: string;
  } | null;
  status:
    | "not_submitted"
    | "submitted"
    | "in_review"
    | "approved"
    | "rejected"
    | "expired"
    | "cancelled";
  doc_type: "passport" | "id_card" | "bio_passport";
  legal_name: string;
  tax_id: string;
  submitted_at: string;
  reviewed_at: string | null;
  rejection_code: string | null;
};

export type AdminKycFilter = "open" | "approved" | "rejected";

export const REJECTION_CODES = [
  "document_expired",
  "document_unreadable",
  "document_mismatch",
  "selfie_mismatch",
  "data_inconsistency",
  "unsupported_document_type",
  "incomplete_submission",
  "fraud_suspicion",
  "other",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export const REJECTION_LABELS: Record<RejectionCode, string> = {
  document_expired: "Документ протермінований",
  document_unreadable: "Документ нечитаний",
  document_mismatch: "Невідповідність документа",
  selfie_mismatch: "Селфі не збігається з фото",
  data_inconsistency: "Дані суперечать одне одному",
  unsupported_document_type: "Тип документа не підтримується",
  incomplete_submission: "Неповна заявка",
  fraud_suspicion: "Підозра на шахрайство",
  other: "Інше",
};

export function useAdminKycQueue(filter: AdminKycFilter) {
  const [items, setItems] = React.useState<AdminKycRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(() => {
    setError(null);
    setItems(null);
    const status = filter === "open" ? "open" : filter;
    apiFetch<{ items: AdminKycRow[] }>(
      `/admin/kyc?status=${encodeURIComponent(status)}`
    )
      .then((r) => setItems(r.items))
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "network_error");
        setItems([]);
      });
  }, [filter]);
  React.useEffect(() => {
    refresh();
  }, [refresh]);
  return { items, error, refresh };
}

export type DecisionError = { message: string; status: number };

export async function approveKyc(
  providerId: string
): Promise<{ ok: true } | { ok: false; error: DecisionError }> {
  try {
    await apiFetch(
      `/admin/kyc/${encodeURIComponent(providerId)}/approve`,
      { method: "POST" }
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const message =
        body?.error === "invalid_state"
          ? "Заявку вже опрацьовано"
          : body?.error === "not_found"
            ? "Заявку не знайдено"
            : e.message;
      return { ok: false, error: { message, status: e.status } };
    }
    return { ok: false, error: { message: "Немає з'єднання", status: 0 } };
  }
}

export async function rejectKyc(
  providerId: string,
  rejection_code: RejectionCode,
  rejection_note?: string
): Promise<{ ok: true } | { ok: false; error: DecisionError }> {
  try {
    await apiFetch(`/admin/kyc/${encodeURIComponent(providerId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ rejection_code, rejection_note }),
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { error?: string } | null;
      const message =
        body?.error === "invalid_rejection_code"
          ? "Невідомий код причини"
          : body?.error === "invalid_state"
            ? "Заявку вже опрацьовано"
            : body?.error === "not_found"
              ? "Заявку не знайдено"
              : e.message;
      return { ok: false, error: { message, status: e.status } };
    }
    return { ok: false, error: { message: "Немає з'єднання", status: 0 } };
  }
}
