"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type KycStatus =
  | "not_submitted"
  | "submitted"
  | "in_review"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export type KycSnapshot = {
  provider_id: string;
  status: KycStatus;
  submitted_at: string | null;
  reviewed_at?: string | null;
  rejection_code?: string | null;
};

export type SubmitKycInput = {
  doc_type: "passport" | "id_card" | "bio_passport";
  doc_media_ids: string[];
  legal_name: string;
  tax_id: string;
  payout_method: "card" | "iban";
  payout_details: {
    card_number?: string;
    iban?: string;
    bank_name: string;
    account_holder: string;
  };
};

export type SubmitKycError = {
  message: string;
  fields?: Record<string, string>;
  status: number;
};

function formatHours(secs?: number): string {
  if (!secs || secs <= 0) return "хвилину";
  const h = Math.ceil(secs / 3600);
  if (h <= 1) return "1 годину";
  if (h < 24) return `${h} год`;
  return `${Math.ceil(h / 24)} дн`;
}

export async function submitKyc(
  input: SubmitKycInput
): Promise<
  | { ok: true; submitted_at: string }
  | { ok: false; error: SubmitKycError }
> {
  try {
    const r = await apiFetch<{ status: KycStatus; submitted_at: string }>(
      "/kyc/me/submissions",
      { method: "POST", body: JSON.stringify(input) }
    );
    return { ok: true, submitted_at: r.submitted_at };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as
        | { error?: string; fields?: Record<string, string> }
        | null;
      const retry = (body as { retry_after_seconds?: number } | null)
        ?.retry_after_seconds;
      const message =
        e.status === 400 && body?.error === "validation_failed"
          ? "Перевірте поля форми"
          : e.status === 429 && body?.error === "resubmit_too_soon"
            ? `Повторна подача дозволена через ${formatHours(retry)}`
            : e.status === 429 && body?.error === "submission_limit_reached"
              ? "Перевищено ліміт подач — зверніться у підтримку"
              : e.status === 409 && body?.error === "already_submitted"
                ? "Заявка вже на розгляді"
                : e.status === 409 && body?.error === "already_approved"
                  ? "Перевірку вже пройдено"
                  : e.status === 403
                    ? "Лише виконавець може подати KYC"
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

export function useKycStatus() {
  const [data, setData] = React.useState<KycSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(() => {
    setError(null);
    apiFetch<KycSnapshot>("/kyc/me")
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "network_error"));
  }, []);
  React.useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, error, refresh };
}
