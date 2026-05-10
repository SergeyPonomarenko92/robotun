"use client";
import * as React from "react";
import { cn } from "@/lib/cn";

type IconTone = "success" | "info" | "accent" | "warning";

const TONE_BG: Record<IconTone, string> = {
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
  warning: "bg-warning-soft text-warning",
};

export type SuccessStep = {
  n: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Активний (поточний) крок — підкреслюється рамкою/фоном */
  active?: boolean;
};

type SuccessScreenProps = {
  /** Іконка-герой у кружечку зверху */
  icon: React.ReactNode;
  iconTone?: IconTone;
  /** Моно-kicker над h1 */
  kicker?: React.ReactNode;
  /** Display-title (компонується викликаючим з <br/> + italic-span) */
  title: React.ReactNode;
  /** Lead-параграф під h1 */
  description?: React.ReactNode;
  /** Опц. вузький слот для бейджа під параграфом (KYCStatusBadge тощо) */
  badge?: React.ReactNode;
  /** Кнопки дій — flex з gap-3, justify-center */
  actions?: React.ReactNode;
  /** "Що далі" список (3-4 кроки) */
  steps?: SuccessStep[];
  className?: string;
};

export function SuccessScreen({
  icon,
  iconTone = "success",
  kicker,
  title,
  description,
  badge,
  actions,
  steps,
  className,
}: SuccessScreenProps) {
  return (
    <main
      className={cn(
        "mx-auto max-w-3xl px-4 md:px-6 py-20 md:py-32 text-center",
        className
      )}
    >
      <span
        className={cn(
          "inline-flex h-16 w-16 items-center justify-center rounded-full mb-8",
          TONE_BG[iconTone]
        )}
        aria-hidden
      >
        {icon}
      </span>

      {kicker && (
        <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-3">
          {kicker}
        </p>
      )}

      <h1 className="font-display text-h1 md:text-display text-ink leading-[0.98] tracking-tight">
        {title}
      </h1>

      {description && (
        <p className="mt-6 text-body-lg text-ink-soft max-w-xl mx-auto leading-relaxed">
          {description}
        </p>
      )}

      {badge && <div className="mt-8 inline-flex">{badge}</div>}

      {actions && (
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          {actions}
        </div>
      )}

      {steps && steps.length > 0 && (
        <ol
          className={cn(
            "mt-16 grid grid-cols-1 gap-4 text-left",
            steps.length === 2 && "md:grid-cols-2",
            steps.length === 3 && "md:grid-cols-3",
            steps.length >= 4 && "md:grid-cols-4"
          )}
        >
          {steps.map((s) => (
            <li
              key={s.n}
              className={cn(
                "rounded-[var(--radius-md)] border p-5",
                s.active ? "border-ink bg-paper" : "border-hairline bg-canvas"
              )}
            >
              <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-2">
                Крок {s.n}
              </p>
              <p
                className={cn(
                  "font-display text-body-lg leading-tight",
                  s.active ? "text-ink" : "text-muted"
                )}
              >
                {s.label}
              </p>
              {s.hint && (
                <p className="mt-1 text-caption text-muted">{s.hint}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
