"use client";
import * as React from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";

type ThemeToggleProps = {
  className?: string;
  /** За замовчуванням icon-button розміру md. На mobile може потребувати sm. */
  size?: "sm" | "md";
};

/**
 * Згорнутий toggle: Sun ↔ Moon. Перемикає light↔dark, перебиваючи "system".
 * Для повноцінного picker з system-варіантом — окремий компонент пізніше.
 */
export function ThemeToggle({ className, size = "md" }: ThemeToggleProps) {
  const { resolved, toggle } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // На SSR показуємо нейтральний placeholder (без іконки) щоб уникнути
  // hydration mismatch коли система = dark, а localStorage = light.
  const iconSize = size === "sm" ? 14 : 16;
  const isDark = resolved === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Перемкнути на світлу тему" : "Перемкнути на темну тему"}
      aria-pressed={isDark}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-sm)] border border-hairline-strong bg-paper text-ink hover:border-ink hover:bg-elevated transition-colors",
        size === "sm" ? "h-8 w-8" : "h-10 w-10",
        className
      )}
    >
      {mounted ? (
        isDark ? <Sun size={iconSize} /> : <Moon size={iconSize} />
      ) : (
        <span className="h-3 w-3 rounded-full bg-hairline-strong" aria-hidden />
      )}
    </button>
  );
}
