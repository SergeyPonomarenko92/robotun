import { NextResponse } from "next/server";
import { authorize } from "../_mock/store";
import {
  userListingsStore,
  type ListingDetailProjection,
} from "../_mock/listings";

/**
 * POST /api/v1/listings — create a listing.
 *
 * Per Module 5 §4.5 a real backend creates `draft` then publish flow gates
 * `active`. Demo shortcut: status comes back synthesized as a public listing
 * so it shows up in feed + detail immediately for E2E. status is mirrored in
 * `published_at` (now). When real backend ships this becomes:
 *   POST /listings        -> 201 draft
 *   POST /listings/{id}/publish -> {status: 'active'|'in_review'}
 *
 * Validation echoes spec field caps so the wizard can map server errors to
 * step badges via the `validation_failed.fields` projection.
 */

type CreateListingBody = {
  title?: string;
  description?: string;
  category_id?: string;
  category_path?: { l1?: { id?: string; name?: string }; l2?: { id?: string; name?: string }; l3?: { id?: string; name?: string } };
  city?: string;
  region?: string;
  tags?: string[];
  pricing_type?: "visit" | "hour" | "project" | "from";
  price_amount_kopecks?: number;
  escrow_deposit?: boolean;
  response_sla_minutes?: number;
  gallery?: { src: string; alt?: string; is_cover?: boolean }[];
};

const TITLE_MIN = 12;
const TITLE_MAX = 120;
const DESC_MIN = 80;
const DESC_MAX = 4000;
const PRICE_MIN_KOPECKS = 5000;
const PRICE_MAX_KOPECKS = 50_000_000;
const VALID_PRICING_TYPES = new Set(["visit", "hour", "project", "from"]);

function priceUnitFor(t: string): string {
  return t === "visit"
    ? "/виклик"
    : t === "hour"
      ? "/год"
      : t === "project"
        ? "/проект"
        : "";
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: CreateListingBody;
  try {
    body = (await req.json()) as CreateListingBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const fields: Record<string, string> = {};
  const title = (body.title ?? "").trim();
  if (title.length < TITLE_MIN) fields.title = "title_too_short";
  else if (title.length > TITLE_MAX) fields.title = "title_too_long";

  const description = (body.description ?? "").trim();
  if (description.length < DESC_MIN) fields.description = "description_too_short";
  else if (description.length > DESC_MAX) fields.description = "description_too_long";

  const categoryId = body.category_id ?? body.category_path?.l3?.id;
  if (!categoryId) fields.category_id = "category_required";

  const city = (body.city ?? "").trim();
  if (!city) fields.city = "city_required";

  const pricingType = body.pricing_type;
  if (!pricingType || !VALID_PRICING_TYPES.has(pricingType))
    fields.pricing_type = "pricing_type_invalid";

  const price = body.price_amount_kopecks;
  if (!Number.isFinite(price) || (price ?? 0) < PRICE_MIN_KOPECKS)
    fields.price_amount_kopecks = "price_too_low";
  else if ((price ?? 0) > PRICE_MAX_KOPECKS)
    fields.price_amount_kopecks = "price_too_high";

  const gallery = body.gallery ?? [];
  if (gallery.length < 1) fields.gallery = "gallery_required";
  else if (gallery.length > 10) fields.gallery = "gallery_too_many";
  else if (!gallery.some((g) => g.is_cover)) fields.gallery = "cover_required";

  if (Object.keys(fields).length > 0) {
    return NextResponse.json(
      { error: "validation_failed", fields },
      { status: 400 }
    );
  }

  const id = uuid();
  const nowIso = new Date().toISOString();
  const categoryLabel =
    body.category_path?.l2?.name ??
    body.category_path?.l3?.name ??
    "Інше";
  const coverSrc =
    gallery.find((g) => g.is_cover)?.src ?? gallery[0].src;

  const detail: ListingDetailProjection = {
    id,
    title,
    cover_url: coverSrc,
    price_from_kopecks: price!,
    price_unit: priceUnitFor(pricingType!),
    city,
    region: body.region,
    category: categoryLabel,
    category_id: categoryId!,
    flags: ["Новий"],
    response_time:
      body.response_sla_minutes && body.response_sla_minutes > 0
        ? `відп. за ${body.response_sla_minutes} хв`
        : undefined,
    provider: {
      id: auth.user.id,
      name: auth.user.display_name,
      avatar_url: auth.user.avatar_url,
      kyc_verified: auth.user.kyc_status === "approved",
      avg_rating: 5.0,
      reviews_count: 0,
      completed_deals_count: 0,
    },
    feed_base_score: 50,
    description,
    gallery: gallery.map((g, i) => ({
      id: `g${i}`,
      url: g.src,
      alt: g.alt ?? title,
      is_cover: !!g.is_cover,
    })),
    brand_tags: body.tags ?? [],
    includes: [
      "Виїзд та консультація",
      "Робота та матеріали",
      "Гарантія на роботу",
    ],
    excludes: [],
    faq: [
      {
        q: "Як проходить оплата?",
        a: "Через ескроу — кошти заморожуються до завершення угоди.",
      },
    ],
    price_range_kopecks: { min: price!, max: price! * 3 },
    warranty_months: 12,
    aggregate_rating: { avg: 0, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
    reviews_preview: [],
    related_ids: [],
    published_at: nowIso,
  };

  userListingsStore.insert(detail);

  return NextResponse.json(detail, { status: 201 });
}
