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
}
function db() {
  if (!globalThis.__ROBOTUN_MFA__) {
    globalThis.__ROBOTUN_MFA__ = new Map();
  }
  return globalThis.__ROBOTUN_MFA__;
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
