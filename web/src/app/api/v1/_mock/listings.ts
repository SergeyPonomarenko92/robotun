/**
 * Module 5+8 mock — 50 deterministic listings + feed_base_score per the spec.
 *
 * Score is a stable function of listing properties (rating × reviews × KYC ×
 * recency seed) so cursor pagination is deterministic across requests in the
 * same process. NOT an implementation of the real PostgreSQL `feed_base_score`
 * IMMUTABLE SQL fn — that lives in the backend; this mock just produces
 * a consistent ordering for FE testing.
 */

export type ListingProjection = {
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
  response_time?: string;
  provider: {
    id: string;
    name: string;
    avatar_url?: string;
    kyc_verified: boolean;
    avg_rating: number;
    reviews_count: number;
    completed_deals_count: number;
  };
  /** Internal — used for ranking + cursor; never sent if you trim. Sent here
   *  for FE introspection only. */
  feed_base_score: number;
};

/** Detail projection — superset returned by GET /listings/:id (Module 5+7). */
export type ListingDetailProjection = ListingProjection & {
  description: string;
  gallery: { id: string; url: string; alt: string; is_cover: boolean }[];
  brand_tags: string[];
  includes: string[];
  excludes: string[];
  faq: { q: string; a: string }[];
  /** Стартовий-фінальний діапазон цін за діагностикою / типовою задачею. */
  price_range_kopecks: { min: number; max: number };
  warranty_months: number;
  aggregate_rating: {
    avg: number;
    total: number;
    /** {5: 248, 4: 52, 3: 14, 2: 4, 1: 2} */
    distribution: Record<number, number>;
  };
  /** Top-3 published reviews; full pagination via /listings/:id/reviews. */
  reviews_preview: {
    id: string;
    rating: number;
    body: string;
    created_at: string;
    author: { display_name: string; avatar_url?: string };
    deal_ref?: string;
    reply?: { body: string; created_at: string };
    status: "published";
  }[];
  related_ids: string[];
  published_at: string;
};

const CATEGORIES = [
  { id: "rep-wash", label: "Ремонт побутової техніки", parent: "rep" },
  { id: "rep-fridge", label: "Холодильники", parent: "rep" },
  { id: "el-house", label: "Електрика", parent: "el" },
  { id: "plumb", label: "Сантехніка", parent: "plumb" },
  { id: "clean-flat", label: "Прибирання", parent: "clean" },
  { id: "furn", label: "Меблі під замовлення", parent: "furn" },
  { id: "fix", label: "Дрібний ремонт", parent: "fix" },
  { id: "climate", label: "Клімат-системи", parent: "climate" },
];

const CITIES = ["Київ", "Львів", "Харків", "Одеса", "Дніпро", "Запоріжжя", "Вінниця", "Полтава"];

const PROVIDER_NAMES: { name: string; avatar: number }[] = [
  { name: "Bosch Group Service", avatar: 12 },
  { name: "CleanWave", avatar: 22 },
  { name: "Микола Петренко", avatar: 8 },
  { name: "Олег Б.", avatar: 15 },
  { name: "Wood Atelier", avatar: 44 },
  { name: "FixIt", avatar: 33 },
  { name: "AquaPro", avatar: 18 },
  { name: "ClimateLab", avatar: 24 },
  { name: "Сергій Л.", avatar: 51 },
  { name: "Олена К.", avatar: 47 },
];

const TITLES_BY_CAT: Record<string, string[]> = {
  "rep-wash": [
    "Ремонт пральних машин Bosch / Siemens — виїзд по {city}",
    "Заміна підшипників і ТЕНів — пральні машини всіх брендів",
    "Сервіс LG / Samsung — гарантія 12 місяців",
    "Майстер з ремонту Whirlpool / Indesit",
  ],
  "rep-fridge": [
    "Ремонт холодильників — виїзд по {city} і області",
    "Заправка фреоном Liebherr / Bosch — на місці",
  ],
  "el-house": [
    "Електрик — заміна проводки, штробління, монтаж",
    "Встановлення розеток та світильників — швидко",
    "Електрощити та автомати — професійно",
  ],
  plumb: [
    "Сантехніка — заміна змішувачів, унітаз, бойлер",
    "Підключення посудомийних машин — гарантія 12 міс.",
    "Прокладання труб і стояків — досвід 10+",
  ],
  "clean-flat": [
    "Прибирання після ремонту — генеральне з вивозом сміття",
    "Регулярне прибирання квартир / офісів",
    "Хімчистка диванів і килимів вдома",
  ],
  furn: [
    "Меблі під замовлення — кухні, шафи-купе, гардеробні",
    "Ремонт і реставрація меблів",
  ],
  fix: [
    "Майстер на годину — дрібний ремонт у квартирі",
    "Збірка меблів IKEA / JYSK — вдома у клієнта",
  ],
  climate: [
    "Чистка та сервіс кондиціонерів — комплексно",
    "Монтаж кондиціонерів сплит-систем",
  ],
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function uuid5(seed: string): string {
  const h = hash(seed).toString(16).padStart(8, "0");
  const h2 = hash(seed + "x").toString(16).padStart(8, "0");
  return `${h.slice(0, 8)}-${h2.slice(0, 4)}-4${h.slice(0, 3)}-8${h2.slice(0, 3)}-${(h + h2).slice(0, 12).padEnd(12, "0")}`;
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

/** Deterministic generator — same seed → same listings. */
function generateListings(): ListingProjection[] {
  const out: ListingProjection[] = [];
  let i = 0;
  for (const cat of CATEGORIES) {
    for (const titleTpl of TITLES_BY_CAT[cat.id] ?? []) {
      for (let cIdx = 0; cIdx < CITIES.length; cIdx++) {
        if (out.length >= 50) break;
        const city = CITIES[cIdx];
        const seed = `${cat.id}:${cIdx}:${i}`;
        const h = hash(seed);
        const provider = pick(PROVIDER_NAMES, h);
        const rating = 3.8 + ((h % 13) / 10); // 3.8 .. 5.0
        const reviews = 8 + (h % 320);
        const completed = reviews + (h % 80);
        const kyc = h % 5 !== 0; // ~80% KYC
        const priceBase =
          cat.id === "furn" ? 800000 + (h % 1500000) :
          cat.id === "rep-wash" ? 30000 + (h % 80000) :
          cat.id === "rep-fridge" ? 35000 + (h % 60000) :
          cat.id === "el-house" ? 40000 + (h % 70000) :
          cat.id === "plumb" ? 35000 + (h % 70000) :
          cat.id === "clean-flat" ? 50000 + (h % 250000) :
          cat.id === "climate" ? 60000 + (h % 200000) :
          25000 + (h % 60000);
        const priceUnit =
          cat.id === "furn" ? "/проект" :
          cat.id === "el-house" ? "/год" :
          cat.id === "fix" ? "/год" :
          cat.id === "clean-flat" ? "/обʼєкт" :
          "/виклик";

        const flags: string[] = [];
        if (rating >= 4.85 && reviews > 150) flags.push("Топ-1%");
        if (h % 7 === 0) flags.push("Швидкий");
        if (h % 11 === 0) flags.push("Новий");
        if (priceBase > 1000000) flags.push("Преміум");

        // Mock score: rating-weighted * sqrt(reviews) * KYC bonus * seed jitter
        const kycBonus = kyc ? 1.0 : 0.85;
        const score =
          rating * Math.sqrt(Math.min(reviews, 200) / 200) * 100 * kycBonus +
          ((h % 13) - 6); // small noise

        out.push({
          id: uuid5(`listing:${seed}`),
          title: titleTpl.replace("{city}", city),
          cover_url: `https://picsum.photos/seed/r-${cat.id}-${cIdx}-${i}/640/480`,
          price_from_kopecks: priceBase,
          price_unit: priceUnit,
          city,
          region: city + "ська обл.",
          category: cat.label,
          category_id: cat.id,
          flags,
          response_time: rating >= 4.7 ? `відп. за ${5 + (h % 30)} хв` : undefined,
          provider: {
            id: uuid5(`provider:${provider.name}`),
            name: provider.name,
            avatar_url: `https://i.pravatar.cc/120?img=${provider.avatar}`,
            kyc_verified: kyc,
            avg_rating: Number(rating.toFixed(1)),
            reviews_count: reviews,
            completed_deals_count: completed,
          },
          feed_base_score: Number(score.toFixed(2)),
        });
        i++;
      }
    }
  }
  return out;
}

let _cache: ListingProjection[] | null = null;
export function listAllListings(): ListingProjection[] {
  if (!_cache) _cache = generateListings();
  return _cache;
}

export function findListing(id: string): ListingProjection | undefined {
  return listAllListings().find((l) => l.id === id);
}

/* =====================================================================
   Detail synthesis — derived from base projection + deterministic seed.
   Real backend returns this from a JOIN over listings + listing_media +
   reviews_aggregate + reviews (Module 5/7). Mock just synthesizes.
   ===================================================================== */

const REVIEW_BODIES = [
  "Зателефонували — приїхали через 40 хв. Замінили підшипники, дали гарантію на 6 місяців. Усе чисто, прибрали за собою. Рекомендую без вагань.",
  "Діагностика безкоштовна — це чесно. Виявили зношений ТЕН, замінили того ж дня. Ескроу — вперше користувався, дуже зручно.",
  "Ремонт зробили якісно, але запчастину чекали 3 дні. Майстер тримав у курсі — це плюс.",
  "Швидко відреагували на запит, узгодили час, виконали в межах кошторису. Дякую за професіоналізм.",
  "Все гаразд, але хотілось би коротший час відповіді на повторні питання.",
];

const REVIEWERS = [
  { name: "Олена К.", avatar: 47 },
  { name: "Андрій М.", avatar: 33 },
  { name: "Наталія Ш.", avatar: 0 },
  { name: "Тарас О.", avatar: 21 },
  { name: "Ірина Д.", avatar: 49 },
];

const FAQ_TEMPLATES: Record<string, { q: string; a: string }[]> = {
  default: [
    {
      q: "Чи виїжджаєте за межі міста?",
      a: "Так, область — додатковий збір 100–300 ₴ залежно від відстані.",
    },
    {
      q: "Скільки триває діагностика?",
      a: "20–40 хвилин. Якщо не беретесь за ремонт — діагностика безкоштовна.",
    },
    {
      q: "Що з гарантією?",
      a: "12 місяців на роботу та оригінальні запчастини. Підтвердження — у деталях угоди.",
    },
  ],
};

const INCLUDES_BY_CAT: Record<string, string[]> = {
  "rep-wash": [
    "Виїзд та діагностика — безкоштовно",
    "Заміна підшипників, ТЕНів, насосів",
    "Прошивка модулів управління",
    "Усунення протікань та засмічень",
    "Заміна манжет, амортизаторів",
    "Гарантія 12 міс. на роботу",
  ],
  "rep-fridge": [
    "Виїзд та діагностика",
    "Заправка фреоном",
    "Заміна термодатчиків",
    "Ремонт компресорів",
    "Гарантія 12 міс.",
  ],
  default: [
    "Виїзд та консультація",
    "Робота та матеріали",
    "Прибирання після виконання",
    "Гарантія на роботу",
  ],
};

function buildAggregateRating(
  rating: number,
  totalReviews: number
): { avg: number; total: number; distribution: Record<number, number> } {
  // Bell-ish distribution skewed by avg rating
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let remaining = totalReviews;
  for (let star = 5; star >= 1; star--) {
    const weight =
      star === 5
        ? rating > 4.7
          ? 0.78
          : 0.55
        : star === 4
          ? rating > 4.5
            ? 0.16
            : 0.25
          : star === 3
            ? 0.05
            : star === 2
              ? 0.015
              : 0.005;
    const count =
      star === 1 ? remaining : Math.round(totalReviews * weight);
    dist[star] = Math.min(count, remaining);
    remaining -= dist[star];
  }
  return { avg: Number(rating.toFixed(2)), total: totalReviews, distribution: dist };
}

export function projectListingDetail(
  base: ListingProjection
): ListingDetailProjection {
  const h = hash(base.id);
  const galleryCount = 4 + (h % 3); // 4..6
  const gallerySeeds = [
    "1581092335397-9583eb92d232",
    "1581092580497-e0d23cbdf1dc",
    "1558618666-fcd25c85cd64",
    "1545173168-9f1947eebb7f",
    "1607269512643-ec0c1d2c2b95",
    "1604577415554-b0f4e4ed26be",
  ];
  const gallery = Array.from({ length: galleryCount }).map((_, i) => ({
    id: `g${i}`,
    url: `https://images.unsplash.com/photo-${gallerySeeds[(h + i) % gallerySeeds.length]}?w=1600&q=80`,
    alt: `${base.title} — фото ${i + 1}`,
    is_cover: i === 0,
  }));

  const totalReviews = base.provider.reviews_count;
  const aggregate_rating = buildAggregateRating(
    base.provider.avg_rating,
    totalReviews
  );

  const previewCount = Math.min(3, totalReviews);
  const reviews_preview = Array.from({ length: previewCount }).map((_, i) => {
    const seed = h + i * 17;
    const reviewer = REVIEWERS[seed % REVIEWERS.length];
    const rating = i === 2 ? 4 : 5;
    const created = new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
    const reply =
      i === 0
        ? {
            body: `Дякуємо, ${reviewer.name.split(" ")[0]}! Раді, що все вдалося оперативно.`,
            created_at: new Date(created.getTime() + 8 * 60 * 60 * 1000).toISOString(),
          }
        : undefined;
    return {
      id: `${base.id}-r${i}`,
      rating,
      body: REVIEW_BODIES[seed % REVIEW_BODIES.length],
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
      status: "published" as const,
    };
  });

  const includes =
    INCLUDES_BY_CAT[base.category_id] ?? INCLUDES_BY_CAT.default;

  // Related: 3 listings from the same category, excluding self.
  const sameCat = listAllListings()
    .filter((l) => l.category_id === base.category_id && l.id !== base.id)
    .slice(0, 3);

  const description =
    base.category_id === "rep-wash"
      ? "Ремонтуємо пральні машини всіх популярних брендів — Bosch, Siemens, AEG, Electrolux, LG, Samsung. Працюємо лише з оригінальними запчастинами. Майстри з досвідом 8+ років приїжджають з повним інструментом."
      : `Виконуємо роботу швидко й якісно у місті ${base.city} та області. Безкоштовна діагностика, прозорий кошторис до старту, гарантія на роботу. Усі узгодження — через ескроу.`;

  return {
    ...base,
    description,
    gallery,
    brand_tags:
      base.category_id === "rep-wash"
        ? ["Bosch", "Siemens", "AEG", "Electrolux", "LG", "Samsung", "Whirlpool"]
        : [],
    includes,
    excludes:
      base.category_id === "rep-wash"
        ? [
            "ремонт промислового обладнання",
            "перевстановлення без виклику",
            "онлайн-консультації без діагностики",
          ]
        : [],
    faq: FAQ_TEMPLATES.default,
    price_range_kopecks: {
      min: base.price_from_kopecks,
      max: base.price_from_kopecks * (3 + (h % 4)), // 3-6× the floor
    },
    warranty_months: 12,
    aggregate_rating,
    reviews_preview,
    related_ids: sameCat.map((l) => l.id),
    published_at: new Date(
      Date.now() - (1 + (h % 14)) * 24 * 60 * 60 * 1000
    ).toISOString(),
  };
}

/* =====================================================================
   Cursor encoding — Module 8 spec uses HMAC-signed base64url JSON.
   Here we just base64url the JSON; comment about real impl.
   ===================================================================== */
export type FeedCursor = { score: number; id: string; v: 1 };

export function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeCursor(s: string): FeedCursor | null {
  try {
    const json = Buffer.from(
      s.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    const obj = JSON.parse(json);
    if (
      typeof obj?.score === "number" &&
      typeof obj?.id === "string" &&
      obj?.v === 1
    )
      return obj;
  } catch {
    /* fallthrough */
  }
  return null;
}
