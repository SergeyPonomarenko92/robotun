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

// Real backend (api/) Module 4 stores typed kyc_documents rows, FE wizard
// collects a single doc_type + ordered media_ids. Map FE → BE document_type
// enum and emit one documents[] entry per uploaded media.
type BeDocType = "passport_ua" | "passport_foreign" | "id_card" | "rnokpp" | "fop_certificate" | "selfie";
const FE_TO_BE_DOC_TYPE: Record<SubmitKycInput["doc_type"], BeDocType> = {
  id_card: "id_card",
  passport: "passport_ua",
  bio_passport: "passport_foreign",
};

function toBackendDocuments(
  input: SubmitKycInput
): Array<{ document_type: BeDocType; media_id: string }> {
  const beType = FE_TO_BE_DOC_TYPE[input.doc_type];
  return input.doc_media_ids.map((media_id) => ({
    document_type: beType,
    media_id,
  }));
}

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
  // Dual-shape payload: real backend reads `documents[]`, Next.js mock route
  // reads the flat FE fields. Both ignore the keys they do not recognise so a
  // single body works against either origin.
  const payload = { ...input, documents: toBackendDocuments(input) };
  try {
    const r = await apiFetch<{ status?: KycStatus; submitted_at?: string }>(
      "/kyc/me/submissions",
      { method: "POST", body: JSON.stringify(payload) }
    );
    // Real BE returns { kyc_id, status:'submitted', submission_index } and
    // does not echo submitted_at; mock returns { provider_id, status, submitted_at }.
    // Fall back to "now" so the UI advance never blocks on a missing field.
    return { ok: true, submitted_at: r.submitted_at ?? new Date().toISOString() };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as
        | {
            error?: string;
            fields?: Record<string, string>;
            current_status?: string;
            retry_at?: string;
            retry_after_seconds?: number;
          }
        | null;
      const code = body?.error;
      // Mock returns retry_after_seconds; real BE returns retry_at ISO.
      const retry =
        body?.retry_after_seconds ??
        (body?.retry_at
          ? Math.max(0, Math.ceil((new Date(body.retry_at).getTime() - Date.now()) / 1000))
          : undefined);
      // Real BE rolls (already_submitted, already_approved) into invalid_state
      // with details.current_status — collapse both into FE-canonical message.
      const invalidStateMsg =
        code === "invalid_state" && body?.current_status === "approved"
          ? "Перевірку вже пройдено"
          : code === "invalid_state"
            ? "Заявка вже на розгляді"
            : null;
      const message =
        e.status === 400 && code === "validation_failed"
          ? "Перевірте поля форми"
          : e.status === 400 && code === "invalid_body"
            ? "Невірний формат форми"
            : e.status === 422 && code === "incomplete_submission"
              ? "Додайте принаймні один документ"
              : e.status === 422 && code === "too_many_documents"
                ? "Забагато документів — максимум 10"
                : e.status === 422 &&
                    (code === "invalid_rnokpp_format" ||
                      code === "invalid_rnokpp_checksum" ||
                      code === "invalid_id_card_format" ||
                      code === "invalid_passport_ua_format" ||
                      code === "invalid_passport_foreign_format")
                  ? "Невірний формат документа"
                  : e.status === 422 && code === "invalid_media_purpose"
                    ? "Файл не є KYC-документом"
                    : e.status === 409 && code === "media_not_ready"
                      ? "Файл ще обробляється — спробуйте за секунду"
                      : e.status === 404 && code === "media_not_found"
                        ? "Завантажений файл не знайдено"
                        : (e.status === 429 &&
                              (code === "resubmit_too_soon" || code === "cooling_off_active"))
                          ? `Повторна подача дозволена через ${formatHours(retry)}`
                          : (e.status === 429 &&
                                (code === "submission_limit_reached" ||
                                  code === "submission_limit_exceeded"))
                            ? "Перевищено ліміт подач — зверніться у підтримку"
                            : e.status === 409 && code === "already_submitted"
                              ? "Заявка вже на розгляді"
                              : e.status === 409 && code === "already_approved"
                                ? "Перевірку вже пройдено"
                                : invalidStateMsg
                                  ? invalidStateMsg
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
