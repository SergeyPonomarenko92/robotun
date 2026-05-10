"use client";
import * as React from "react";
import {
  apiFetch,
  ApiError,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  setOnAuthLost,
} from "./api";

export type Role = "client" | "provider" | "admin";

export type AuthUser = {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  email_verified: boolean;
  status: "pending" | "active" | "suspended" | "deleted";
  roles: Role[];
  has_provider_role: boolean;
  kyc_status: "none" | "submitted" | "approved" | "rejected" | "expired";
  payout_enabled: boolean;
  mfa_enrolled: boolean;
};

type AuthState =
  | { status: "loading"; user: null }
  | { status: "authenticated"; user: AuthUser }
  | { status: "unauthenticated"; user: null };

type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    initial_role: "client" | "provider";
  }) => Promise<{ user_id: string; email_verification_required: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({
    status: "loading",
    user: null,
  });

  const logoutLocal = React.useCallback(() => {
    setAccessToken(null);
    setRefreshToken(null);
    setState({ status: "unauthenticated", user: null });
  }, []);

  // Wire api.ts → AuthProvider so refresh failure clears React state
  React.useEffect(() => {
    setOnAuthLost(logoutLocal);
    return () => setOnAuthLost(null);
  }, [logoutLocal]);

  const refreshUser = React.useCallback(async () => {
    try {
      const me = await apiFetch<AuthUser>("/users/me");
      setState({ status: "authenticated", user: me });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        logoutLocal();
        return;
      }
      // Network / other — keep current state, don't auto-logout
      console.error("refreshUser failed:", err);
    }
  }, [logoutLocal]);

  // Bootstrap: if refresh token exists, try to fetch /me (api.ts handles refresh)
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const refresh = getRefreshToken();
      if (!refresh) {
        if (!cancelled) setState({ status: "unauthenticated", user: null });
        return;
      }
      try {
        const me = await apiFetch<AuthUser>("/users/me");
        if (!cancelled) setState({ status: "authenticated", user: me });
      } catch {
        if (!cancelled) logoutLocal();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logoutLocal]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      const data = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        anonymous: true,
      });
      setAccessToken(data.access_token);
      setRefreshToken(data.refresh_token);
      const me = await apiFetch<AuthUser>("/users/me");
      setState({ status: "authenticated", user: me });
    },
    []
  );

  const register = React.useCallback(
    async (input: {
      email: string;
      password: string;
      initial_role: "client" | "provider";
    }) => {
      return apiFetch<{
        user_id: string;
        email_verification_required: boolean;
      }>("/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
        anonymous: true,
      });
    },
    []
  );

  const logout = React.useCallback(async () => {
    const refresh = getRefreshToken();
    try {
      if (refresh) {
        await apiFetch("/auth/logout", {
          method: "POST",
          body: JSON.stringify({ refresh_token: refresh }),
        });
      }
    } catch {
      /* ignore — local logout is what matters */
    } finally {
      logoutLocal();
    }
  }, [logoutLocal]);

  const value = React.useMemo<AuthContextValue>(
    () => ({ ...state, login, register, logout, refreshUser }),
    [state, login, register, logout, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside <AuthProvider>");
  return ctx;
}

/**
 * Use in a page that requires auth. Returns { user } when authenticated,
 * `null` while loading, and triggers redirect to /login on unauthenticated.
 */
export function useRequireAuth(redirectTo = "/login"): {
  user: AuthUser;
} | null {
  const auth = useAuth();
  React.useEffect(() => {
    if (auth.status === "unauthenticated" && typeof window !== "undefined") {
      const next = encodeURIComponent(window.location.pathname);
      window.location.replace(`${redirectTo}?next=${next}`);
    }
  }, [auth.status, redirectTo]);
  if (auth.status === "authenticated") return { user: auth.user };
  return null;
}
