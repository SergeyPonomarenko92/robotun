"use client";
import * as React from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "robotun.theme";

/**
 * Inline-script який має виконатись синхронно в <head> ДО будь-якого painting,
 * щоб `data-theme` був на <html> з самого старту і не було мерехтіння (FOUC).
 *
 * Логіка:
 *   pref = localStorage["robotun.theme"]  // "light" | "dark" | "system" | null
 *   resolved = pref="system" or null  ->  matchMedia(prefers-color-scheme: dark)
 *              інакше pref
 *   document.documentElement.dataset.theme = resolved
 */
export const themeBootstrapScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});if(p!=='light'&&p!=='dark')p='system';var d=p;if(p==='system')d=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=d;}catch(e){}})();`;

type ThemeContextValue = {
  /** Збережена перевага (light/dark/system) */
  preference: ThemePreference;
  /** Що зараз справді активне (system → resolved до light|dark) */
  resolved: Theme;
  setPreference: (p: ThemePreference) => void;
  /** Перемикач між light↔dark; system режим підхоплюється первинно. */
  toggle: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function resolveTheme(pref: ThemePreference): Theme {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initial state — script вже встановив data-theme. Читаємо звідти, щоб не
  // ризикувати mismatch під час hydration.
  const [preference, setPreferenceState] = React.useState<ThemePreference>(
    () => readPreference()
  );
  const [resolved, setResolved] = React.useState<Theme>(() => {
    if (typeof document === "undefined") return "light";
    return (document.documentElement.dataset.theme as Theme) || "light";
  });

  // Sync resolved → DOM whenever preference changes
  React.useEffect(() => {
    const next = resolveTheme(preference);
    setResolved(next);
    document.documentElement.dataset.theme = next;
  }, [preference]);

  // Listen to system preference if user is on "system"
  React.useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next: Theme = mq.matches ? "dark" : "light";
      setResolved(next);
      document.documentElement.dataset.theme = next;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = React.useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    if (p === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, p);
  }, []);

  const toggle = React.useCallback(() => {
    setPreferenceState((prev) => {
      const cur = resolveTheme(prev);
      const next: Theme = cur === "dark" ? "light" : "dark";
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx)
    throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
