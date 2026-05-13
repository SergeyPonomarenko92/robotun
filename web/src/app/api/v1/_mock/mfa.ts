/**
 * Module 12 §SEC-006 mock — MFA challenge for sensitive admin mutations.
 *
 * Real backend issues a TOTP challenge bound to the admin session, single-use
 * within 5 min, KMS-degraded → 503. Mock generates a 6-digit code and stores
 * it in-process; consumeChallenge() validates and burns it. For demo UX we
 * also expose the code in the challenge response so the operator can copy it
 * without a phone (this is a HARD red flag in prod — code lives only in the
 * authenticator app there).
 */

export type MfaChallenge = {
  id: string;
  admin_id: string;
  code: string;
  /** ISO; 5 min from create. */
  expires_at: string;
  consumed: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_MFA__: Map<string, MfaChallenge> | undefined;
  // eslint-disable-next-line no-var
  var __ROBOTUN_KMS_DEGRADED__: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ROBOTUN_MFA_ISSUE_LOG__: Map<string, number[]> | undefined;
}
function db() {
  if (!globalThis.__ROBOTUN_MFA__) {
    globalThis.__ROBOTUN_MFA__ = new Map();
  }
  return globalThis.__ROBOTUN_MFA__;
}

// -- ADM-SEC-006: KMS-degraded mode ----------------------------------------
// Flag flipped via QA endpoint POST /admin/mfa/_kms (mock-only). When true,
// MFA-issuance endpoint returns 503 admin_mfa_unavailable. Reads + non-MFA
// writes proceed normally (the gate is per-endpoint, applied here only).
export function isKmsDegraded(): boolean {
  return globalThis.__ROBOTUN_KMS_DEGRADED__ === true;
}
export function setKmsDegraded(v: boolean): void {
  globalThis.__ROBOTUN_KMS_DEGRADED__ = v;
}

// -- Per-admin rate limit on challenge issuance ----------------------------
// Sliding window: max ISSUE_LIMIT challenges per ISSUE_WINDOW_MS. Real backend
// uses Redis; mock keeps a per-admin timestamp array on globalThis.
const ISSUE_WINDOW_MS = 60 * 1000; // 1 min
const ISSUE_LIMIT = 5;

function issueLog(): Map<string, number[]> {
  if (!globalThis.__ROBOTUN_MFA_ISSUE_LOG__) {
    globalThis.__ROBOTUN_MFA_ISSUE_LOG__ = new Map();
  }
  return globalThis.__ROBOTUN_MFA_ISSUE_LOG__;
}

export type IssueRateCheck =
  | { ok: true }
  | { ok: false; retry_after_seconds: number };

export function checkAndConsumeIssueRate(adminId: string): IssueRateCheck {
  const now = Date.now();
  const cutoff = now - ISSUE_WINDOW_MS;
  const log = issueLog();
  const arr = (log.get(adminId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= ISSUE_LIMIT) {
    // Retry-After = how long until the oldest in-window timestamp expires.
    const oldest = arr[0];
    const retry = Math.ceil((oldest + ISSUE_WINDOW_MS - now) / 1000);
    log.set(adminId, arr);
    return { ok: false, retry_after_seconds: Math.max(1, retry) };
  }
  arr.push(now);
  log.set(adminId, arr);
  return { ok: true };
}

const TTL_MS = 5 * 60 * 1000;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

function sixDigits(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function createChallenge(adminId: string): MfaChallenge {
  const c: MfaChallenge = {
    id: uuid(),
    admin_id: adminId,
    code: sixDigits(),
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    consumed: false,
  };
  db().set(c.id, c);
  return c;
}

export type ConsumeError =
  | "mfa_missing"
  | "mfa_not_found"
  | "mfa_expired"
  | "mfa_consumed"
  | "mfa_wrong_admin"
  | "mfa_code_invalid";

export function consumeChallenge(input: {
  adminId: string;
  challengeId: string | null;
  code: string | null;
}): MfaChallenge | { error: ConsumeError } {
  if (!input.challengeId || !input.code) return { error: "mfa_missing" };
  const c = db().get(input.challengeId);
  if (!c) return { error: "mfa_not_found" };
  if (c.admin_id !== input.adminId) return { error: "mfa_wrong_admin" };
  if (c.consumed) return { error: "mfa_consumed" };
  if (new Date(c.expires_at).getTime() < Date.now())
    return { error: "mfa_expired" };
  if (c.code !== input.code) return { error: "mfa_code_invalid" };
  c.consumed = true;
  return c;
}
