/**
 * Module 10 §4.4 — slug normalization pipeline.
 *
 * Applied in exact order. Identical implementation MUST run in application
 * code, seed, and CI validators. Property: normalize(normalize(s)) === normalize(s).
 */

const KMU_2010: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e",
  є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch",
  ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", "ʼ": "", "'": "",
};

const RESERVED_SLUGS = new Set([
  "admin", "api", "categories", "proposals", "search", "feed", "listings",
  "deals", "reviews", "users", "me", "static", "cdn", "auth", "help",
  "support", "www", "health", "metrics", "webhooks",
]);

const SLUG_RE = /^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$/;

function translit(s: string): string {
  let out = "";
  for (const ch of s) {
    const low = ch.toLowerCase();
    if (KMU_2010[low] !== undefined) {
      const lat = KMU_2010[low];
      out += ch === low ? lat : lat.toUpperCase();
    } else {
      out += ch;
    }
  }
  return out;
}

function asciiFold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export type SlugResult =
  | { ok: true; slug: string }
  | { ok: false; reason: "reserved_slug" | "invalid_after_normalize" };

export function normalizeSlug(input: string): SlugResult {
  let s = input.normalize("NFC");
  s = translit(s);
  s = asciiFold(s);
  s = s.toLowerCase();
  s = s.replace(/[\s_]+/g, "-");
  s = s.replace(/[^a-z0-9\-]/g, "");
  s = s.replace(/-{2,}/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length > 100) {
    const truncated = s.slice(0, 100);
    const lastDash = truncated.lastIndexOf("-");
    s = lastDash > 0 ? truncated.slice(0, lastDash) : truncated;
    s = s.replace(/-+$/g, "");
  }
  if (RESERVED_SLUGS.has(s)) return { ok: false, reason: "reserved_slug" };
  if (!SLUG_RE.test(s)) return { ok: false, reason: "invalid_after_normalize" };
  return { ok: true, slug: s };
}

export function validateSlugOverride(input: string): SlugResult {
  if (!SLUG_RE.test(input)) return { ok: false, reason: "invalid_after_normalize" };
  if (RESERVED_SLUGS.has(input)) return { ok: false, reason: "reserved_slug" };
  return { ok: true, slug: input };
}
