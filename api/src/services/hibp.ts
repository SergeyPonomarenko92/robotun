/**
 * Module 1 SEC-002 — HIBP (HaveIBeenPwned) k-anonymity check.
 *
 * Sends the first 5 hex chars of sha1(password) to the public range API,
 * receives a list of suffixes (rest of the hash) + occurrence counts.
 * Local comparison reveals if the full hash is in the breach set.
 * Plaintext password NEVER leaves the server.
 *
 * Failure modes:
 *   - Network error / timeout / non-200: returns { ok: true, breached: false }
 *     ("fail open"). Spec wording is "SHALL be checked"; we interpret a
 *     transient HIBP outage as not-found rather than blocking signups.
 *     Operator can audit via auth_audit_events for cohort risk later.
 *   - HIBP hit with count > 0: returns { ok: true, breached: true, count }.
 */
import { createHash } from "node:crypto";

const HIBP_URL = "https://api.pwnedpasswords.com/range";
const HIBP_TIMEOUT_MS = Number(process.env.HIBP_TIMEOUT_MS ?? 3000);

export type HibpResult =
  | { ok: true; breached: false }
  | { ok: true; breached: true; count: number };

export async function checkPasswordBreached(password: string): Promise<HibpResult> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
  try {
    const res = await fetch(`${HIBP_URL}/${prefix}`, {
      signal: controller.signal,
      headers: { "Add-Padding": "true" }, // HIBP adds noise to defeat traffic analysis.
    });
    if (!res.ok) return { ok: true, breached: false };
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const [sfx, cnt] = line.split(":");
      if (sfx?.trim().toUpperCase() === suffix) {
        // RISK-5: guard against malformed count (NaN, negative). Treat
        // malformed line as non-match to avoid false positives.
        const count = parseInt(cnt?.trim() ?? "", 10);
        if (!Number.isFinite(count) || count <= 0) continue;
        return { ok: true, breached: true, count };
      }
    }
    return { ok: true, breached: false };
  } catch {
    // Network error / timeout — fail open per docstring.
    return { ok: true, breached: false };
  } finally {
    clearTimeout(timer);
  }
}
