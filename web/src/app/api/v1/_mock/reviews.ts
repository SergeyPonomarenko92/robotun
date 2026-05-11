/**
 * Module 7 mock — synthesizes per-listing review pages.
 *
 * Same deterministic-by-seed approach as projectListingDetail's
 * reviews_preview (top-3). Here we extend to full listing.reviews_count
 * length so cursor pagination can walk the whole set.
 */

import { findListing } from "./listings";

export type ReviewProjection = {
  id: string;
  rating: number;
  body: string;
  created_at: string;
  author: { display_name: string; avatar_url?: string };
  deal_ref?: string;
  reply?: { body: string; created_at: string };
  status: "published";
};

const BODIES = [
  "Зателефонували — приїхали через 40 хв. Замінили підшипники, дали гарантію на 6 місяців. Усе чисто, прибрали за собою. Рекомендую без вагань.",
  "Діагностика безкоштовна — це чесно. Виявили зношений ТЕН, замінили того ж дня. Ескроу — вперше користувався, дуже зручно.",
  "Ремонт зробили якісно, але запчастину чекали 3 дні. Майстер тримав у курсі — це плюс.",
  "Швидко відреагували на запит, узгодили час, виконали в межах кошторису. Дякую за професіоналізм.",
  "Все гаразд, але хотілось би коротший час відповіді на повторні питання.",
  "Виконали все за один візит, без додаткових витрат. Майстер культурний, акуратно працював.",
  "Запчастина оригінальна, гарантія письмова. Це найважливіше для побутової техніки.",
  "Ціна вища за середню по ринку, але якість виправдовує. Рекомендую для серйозних поломок.",
  "Двічі переносили час візиту через затримки в графіку. Робота сама — на 5. Один зірочку зняв за пунктуальність.",
  "Зателефонував, у той самий день виїхали. Економлять час і нерви.",
];

const REVIEWERS = [
  { name: "Олена К.", avatar: 47 },
  { name: "Андрій М.", avatar: 33 },
  { name: "Наталія Ш.", avatar: 0 },
  { name: "Тарас О.", avatar: 21 },
  { name: "Ірина Д.", avatar: 49 },
  { name: "Богдан П.", avatar: 13 },
  { name: "Світлана В.", avatar: 25 },
  { name: "Максим Р.", avatar: 8 },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function ratingForSeed(seed: number, baseAvg: number): number {
  // Skew distribution toward base average: 70% 5★, 18% 4★, 8% 3★, 3% 2★, 1% 1★
  // tilted by baseAvg.
  const r = seed % 100;
  if (baseAvg >= 4.7) {
    if (r < 78) return 5;
    if (r < 94) return 4;
    if (r < 99) return 3;
    return r % 2 === 0 ? 2 : 1;
  }
  if (baseAvg >= 4.3) {
    if (r < 55) return 5;
    if (r < 80) return 4;
    if (r < 92) return 3;
    return r % 2 === 0 ? 2 : 1;
  }
  if (r < 35) return 5;
  if (r < 65) return 4;
  if (r < 85) return 3;
  return r % 2 === 0 ? 2 : 1;
}

/** Generate ALL reviews for a listing — deterministic, cached per listing id. */
const _cache = new Map<string, ReviewProjection[]>();

export function generateReviewsForListing(listingId: string): ReviewProjection[] {
  const cached = _cache.get(listingId);
  if (cached) return cached;

  const base = findListing(listingId);
  if (!base) {
    _cache.set(listingId, []);
    return [];
  }

  const total = base.provider.reviews_count;
  const avg = base.provider.avg_rating;
  const h = hash(listingId);
  const out: ReviewProjection[] = [];

  for (let i = 0; i < total; i++) {
    const seed = h + i * 17;
    const reviewer = REVIEWERS[seed % REVIEWERS.length];
    const rating = ratingForSeed(seed, avg);
    // Newest first — i=0 is most recent.
    const daysAgo = i + 1 + (seed % 3);
    const created = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    // ~30% of top reviews have a provider reply.
    const reply =
      i < 3 && seed % 3 === 0
        ? {
            body: `Дякуємо, ${reviewer.name.split(" ")[0]}! Раді, що все вдалося оперативно. Звертайтесь ще.`,
            created_at: new Date(
              created.getTime() + 8 * 60 * 60 * 1000
            ).toISOString(),
          }
        : undefined;
    out.push({
      id: `${listingId}-r${i}`,
      rating,
      body: BODIES[seed % BODIES.length],
      created_at: created.toISOString(),
      author: {
        display_name: reviewer.name,
        avatar_url:
          reviewer.avatar > 0
            ? `https://i.pravatar.cc/120?img=${reviewer.avatar}`
            : undefined,
      },
      deal_ref: `DL-${(7000 + (seed % 999)).toString()}`,
      reply,
      status: "published",
    });
  }

  _cache.set(listingId, out);
  return out;
}
