"use client";
import { apiFetch, ApiError } from "./api";

export type PricingType = "visit" | "hour" | "project" | "from";

export type CreateListingInput = {
  title: string;
  description: string;
  category_id: string;
  category_path?: {
    l1?: { id: string; name: string };
    l2?: { id: string; name: string };
    l3?: { id: string; name: string };
  };
  city: string;
  region?: string;
  tags?: string[];
  pricing_type: PricingType;
  price_amount_kopecks: number;
  escrow_deposit?: boolean;
  response_sla_minutes?: number;
  gallery: { src: string; alt?: string; is_cover?: boolean }[];
};

export type ListingDetail = {
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
  description: string;
  provider: {
    id: string;
    name: string;
    avatar_url?: string;
    kyc_verified: boolean;
    avg_rating: number;
    reviews_count: number;
    completed_deals_count: number;
  };
  published_at: string;
};

export type CreateListingError = {
  message: string;
  /** Per-field codes from server `validation_failed.fields`. Keys mirror
   *  the request shape so the form can map them to local field names. */
  fields?: Record<string, string>;
  status: number;
};

export async function createListing(
  input: CreateListingInput
): Promise<
  { ok: true; listing: ListingDetail } | { ok: false; error: CreateListingError }
> {
  try {
    const listing = await apiFetch<ListingDetail>("/listings", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { ok: true, listing };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as
        | { error?: string; fields?: Record<string, string> }
        | null;
      const message =
        e.status === 401
          ? "Потрібно увійти, щоб опублікувати послугу"
          : e.status === 400 && body?.error === "validation_failed"
            ? "Перевірте поля форми"
            : e.status === 403
              ? "У вашого облікового запису немає права публікації"
              : e.status === 409
                ? "Перевищено ліміт активних послуг"
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
