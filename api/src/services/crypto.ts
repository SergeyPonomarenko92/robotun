/**
 * Module 1 §4 — password hashing, JWT mint/verify, refresh-token mint.
 *
 * argon2id is the OWASP-recommended algorithm. Tuning targets ~50–100ms
 * verification on commodity hardware (params per OWASP cheatsheet 2024).
 *
 * Refresh tokens are 32 cryptographically-random bytes serialized as
 * base64url. The token itself is delivered to the client; the SHA-256 hex
 * of it lives in `sessions.refresh_token_hash` so a DB leak yields only
 * hashes (still single-use due to rotation, but defense-in-depth).
 */
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { importPKCS8, importSPKI, SignJWT, jwtVerify, type KeyLike } from "jose";
import { env } from "../config/env.js";

// -------- Password hashing (argon2id) -------------------------------------

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// -------- JWT (RS256) -----------------------------------------------------

let privateKey: KeyLike | null = null;
let publicKey: KeyLike | null = null;

async function loadKeys() {
  if (privateKey && publicKey) return;
  const privPem = readFileSync(env.JWT_PRIVATE_KEY_PATH, "utf8");
  const pubPem = readFileSync(env.JWT_PUBLIC_KEY_PATH, "utf8");
  privateKey = await importPKCS8(privPem, "RS256");
  publicKey = await importSPKI(pubPem, "RS256");
}

export type AccessClaims = {
  sub: string; // user id
  ver: number; // token version
};

export async function mintAccessToken(claims: AccessClaims): Promise<string> {
  await loadKeys();
  return new SignJWT({ ver: claims.ver })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey!);
}

export type VerifiedAccess = {
  sub: string;
  ver: number;
  exp: number;
};

export async function verifyAccessToken(
  token: string
): Promise<VerifiedAccess | null> {
  await loadKeys();
  try {
    const { payload } = await jwtVerify(token, publicKey!, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.ver !== "number") return null;
    if (typeof payload.exp !== "number") return null;
    return { sub: payload.sub, ver: payload.ver, exp: payload.exp };
  } catch {
    return null;
  }
}

// -------- Refresh tokens --------------------------------------------------

/** Returns { plaintext, hash } — plaintext is delivered to the client once;
 *  hash is what we persist in `sessions.refresh_token_hash`. */
export function mintRefreshToken(): { plaintext: string; hash: string } {
  const bytes = randomBytes(32);
  const plaintext = bytes.toString("base64url");
  const hash = sha256Hex(plaintext);
  return { plaintext, hash };
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
