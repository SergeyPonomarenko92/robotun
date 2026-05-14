/**
 * REST client with auto-refresh on 401.
 *
 * Storage strategy (FE-only mock):
 *  - Access token: in-memory module state (refreshed on every page load).
 *    XSS-safer than localStorage; lost on full reload, recovered via refresh.
 *  - Refresh token: localStorage. Production should use httpOnly cookie set
 *    by /auth/* endpoints with credentials:'include'. Swap when real backend
 *    ships — search for ROBOTUN_REFRESH_KEY uses.
 *
 * Module 1: 15-min access TTL + 30d rotating refresh token. On 401 we attempt
 * one refresh; on second 401 (refresh failed) we logout and propagate error.
 */

const REFRESH_KEY = "robotun.refresh";
/**
 * If NEXT_PUBLIC_API_BASE is set at build time, all /api/v1/* requests go
 * to that origin (real backend at :4000 during local dev). Unset → relative
 * "/api/v1" → in-repo Next.js mock route handlers (legacy/MVP behavior).
 *
 * Mixed-mode operation: setting the env routes EVERY request to the real
 * backend; unported modules will 404 until they land. Use per-feature flags
 * in subsequent commits if you need granular cutover.
 */
const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE
    ? `${process.env.NEXT_PUBLIC_API_BASE.replace(/\/$/, "")}/api/v1`
    : "/api/v1"
);

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;
let onAuthLost: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}

export function setRefreshToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(REFRESH_KEY, token);
  else window.localStorage.removeItem(REFRESH_KEY);
}
export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

/**
 * Hook the AuthProvider sets to clear React state when refresh fails.
 * Avoids circular import.
 */
export function setOnAuthLost(fn: (() => void) | null) {
  onAuthLost = fn;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const refresh = getRefreshToken();
  if (!refresh) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) {
        setAccessToken(null);
        setRefreshToken(null);
        onAuthLost?.();
        return null;
      }
      const data = (await res.json()) as {
        access_token: string;
        refresh_token: string;
      };
      setAccessToken(data.access_token);
      setRefreshToken(data.refresh_token);
      return data.access_token;
    } catch {
      setAccessToken(null);
      setRefreshToken(null);
      onAuthLost?.();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

type RequestOptions = RequestInit & {
  /** Не намагатись зробити refresh при 401 (для самого /auth/refresh). */
  skipRefresh?: boolean;
  /** Не вкладати Authorization header (для /auth/login, /auth/register). */
  anonymous?: boolean;
};

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { skipRefresh, anonymous, headers: incomingHeaders, ...rest } = options;
  const headers = new Headers(incomingHeaders);
  if (!headers.has("content-type") && rest.body) {
    headers.set("content-type", "application/json");
  }
  if (!anonymous && accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }

  let res = await fetch(`${API_BASE}${path}`, { ...rest, headers });

  if (res.status === 401 && !skipRefresh && !anonymous) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.set("authorization", `Bearer ${newToken}`);
      res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
    }
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const message =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}
