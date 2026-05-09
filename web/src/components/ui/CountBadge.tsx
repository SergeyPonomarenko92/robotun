import * as React from "react";
import { cn } from "@/lib/cn";

type CountBadgeProps = {
  /** Реальне число */
  value: number;
  /** Верхній капс (вище — `${cap}+`); 99 за замовчуванням */
  cap?: number;
  /** Не показувати, якщо value=0 */
  hideZero?: boolean;
  size?: "sm" | "md";
  /** Tone — `accent` для непрочитаних, `neutral` за замовчуванням */
  tone?: "accent" | "neutral" | "danger";
  className?: string;
};

export function CountBadge({
  value,
  cap = 99,
  hideZero = true,
  size = "sm",
  tone = "neutral",
  className,
}: CountBadgeProps) {
  if (hideZero && value <= 0) return null;
  const display = value > cap ? `${cap}+` : String(value);
  const dim =
    size === "sm"
      ? "h-[18px] min-w-[18px] px-1 text-[10px]"
      : "h-5 min-w-[20px] px-1.5 text-[11px]";
  const toneCls =
    tone === "accent"
      ? "bg-accent text-paper"
      : tone === "danger"
        ? "bg-danger text-paper"
        : "bg-ink text-paper";

  return (
    <span
      aria-label={`${value} ${value === 1 ? "елемент" : "елементів"}`}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-pill)] font-mono tabular-nums leading-none",
        dim,
        toneCls,
        className
      )}
    >
      {display}
    </span>
  );
}
