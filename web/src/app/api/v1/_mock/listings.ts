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
