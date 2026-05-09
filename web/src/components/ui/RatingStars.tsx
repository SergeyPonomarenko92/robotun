"use client";
import * as React from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";

type RatingStarsProps = {
  /** 0..5; підтримує дробові значення в display-mode */
  value: number;
  /** display | input */
  mode?: "display" | "input";
  /** для input: повертає 1..5 */
  onChange?: (next: number) => void;
  /** Кількість рев'ю поряд */
  count?: number;
  size?: "sm" | "md" | "lg";
  /** Якщо false — показує "—" замість зірок при value=0 (display-only) */
  showZero?: boolean;
  className?: string;
  /** Чи дозволяти half-star у display (дробові значення) — true за замовчуванням */
  allowHalf?: boolean;
  ariaLabel?: string;
};

const SIZES = {
  sm: { star: 12, gap: "gap-0.5", text: "text-caption" },
  md: { star: 16, gap: "gap-1", text: "text-body" },
  lg: { star: 20, gap: "gap-1", text: "text-body-lg" },
} as const;

export function RatingStars({
  value,
  mode = "display",
  onChange,
  count,
  size = "md",
  showZero = true,
  className,
  allowHalf = true,
  ariaLabel,
}: RatingStarsProps) {
  const [hover, setHover] = React.useState<number | null>(null);
  const s = SIZES[size];
  const v = mode === "input" && hover != null ? hover : value;
  const clamped = Math.max(0, Math.min(5, v));
  const filled = Math.floor(clamped);
  const fraction = clamped - filled;
  const isInput = mode === "input";

  if (mode === "display" && !showZero && (value == null || value === 0)) {
    return (
      <span className={cn("text-muted-soft", s.text, className)}>— без оцінок</span>
    );
  }

  return (
    <span
      role={isInput ? "radiogroup" : "img"}
      aria-label={
        ariaLabel ?? (isInput ? "Оберіть оцінку" : `Оцінка ${value.toFixed(1)} з 5`)
      }
      className={cn("inline-flex items-center", s.gap, className)}
      onMouseLeave={isInput ? () => setHover(null) : undefined}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const starValue = i + 1;
        const fillPct =
          i < filled
            ? 100
            : i === filled && allowHalf && !isInput
              ? Math.round(fraction * 100)
              : 0;
        const Wrap: keyof React.JSX.IntrinsicElements = isInput ? "button" : "span";
        return (
          <Wrap
            key={i}
            {...(isInput
              ? {
                  type: "button" as const,
                  role: "radio" as const,
                  "aria-checked": value === starValue,
                  "aria-label": `${starValue} з 5`,
                  onMouseEnter: () => setHover(starValue),
                  onClick: () => onChange?.(starValue),
                }
              : {})}
            className={cn(
              "relative inline-flex",
              isInput && "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink rounded-[var(--radius-xs)]"
            )}
          >
            <Star
              size={s.star}
              strokeWidth={1.5}
              className="text-muted-soft"
              fill="transparent"
            />
            <Star
              size={s.star}
              strokeWidth={1.5}
              className={cn(
                "absolute inset-0 text-accent",
                fillPct === 0 && "opacity-0"
              )}
              style={{
                clipPath: `inset(0 ${100 - fillPct}% 0 0)`,
              }}
              fill="currentColor"
            />
          </Wrap>
        );
      })}
      {(typeof count === "number" || mode === "display") && (
        <span className={cn("ml-2 text-muted font-mono tabular-nums", s.text)}>
          {value > 0 ? value.toFixed(1) : showZero ? "0.0" : ""}
          {typeof count === "number" && (
            <span className="text-muted-soft"> · {count}</span>
          )}
        </span>
      )}
    </span>
  );
}
