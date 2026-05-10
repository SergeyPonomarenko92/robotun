"use client";
import * as React from "react";
import { cn } from "@/lib/cn";

export type RadioCardOption<T extends string = string> = {
  id: T;
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Опційна іконка/кнопка справа замість дефолтної radio-крапки */
  trailing?: React.ReactNode;
  disabled?: boolean;
};

type RadioCardGroupProps<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  options: RadioCardOption<T>[];
  /** Кількість колонок у grid на >=sm. На mobile завжди 1. Default 2. */
  columns?: 2 | 3 | 4;
  /** Розмір label-а: md=body-lg, lg=h3 */
  labelSize?: "md" | "lg";
  className?: string;
  ariaLabel?: string;
};

const COLS: Record<2 | 3 | 4, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function RadioCardGroup<T extends string>({
  value,
  onChange,
  options,
  columns = 2,
  labelSize = "md",
  className,
  ariaLabel,
}: RadioCardGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("grid grid-cols-1 gap-3", COLS[columns], className)}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => !o.disabled && onChange(o.id)}
            className={cn(
              "text-left rounded-[var(--radius-md)] border px-4 py-4 transition-all duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
              active
                ? "border-ink bg-ink text-paper"
                : "border-hairline bg-paper text-ink hover:border-ink",
              o.disabled && "opacity-50 cursor-not-allowed hover:border-hairline"
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className={cn(
                  "font-display leading-none",
                  labelSize === "lg" ? "text-h3" : "text-body-lg"
                )}
              >
                {o.label}
              </span>
              {o.trailing ?? (
                <span
                  className={cn(
                    "h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0",
                    active ? "border-paper bg-paper" : "border-hairline-strong"
                  )}
                  aria-hidden
                >
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-ink" />}
                </span>
              )}
            </div>
            {o.hint && (
              <p
                className={cn(
                  "mt-2 text-caption leading-snug",
                  active ? "text-paper/75" : "text-muted"
                )}
              >
                {o.hint}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
