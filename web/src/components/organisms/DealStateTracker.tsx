"use client";
import * as React from "react";
import { Check, AlertTriangle, X, Clock } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Per Module 3 spec-architecture-deal-workflow §4.5 state machine:
 *   pending → active → in_review → completed | disputed | cancelled
 * The tracker shows the linear "happy path" + a divergence callout when the
 * deal lands on disputed/cancelled (terminal-but-anomalous).
 */
export type DealStatus =
  | "pending"
  | "active"
  | "in_review"
  | "completed"
  | "disputed"
  | "cancelled";

export const HAPPY_PATH: DealStatus[] = ["pending", "active", "in_review", "completed"];

const LABELS: Record<DealStatus, string> = {
  pending: "Очікує",
  active: "Активна",
  in_review: "На перевірці",
  completed: "Завершена",
  disputed: "Спір",
  cancelled: "Скасована",
};

const HINTS: Record<DealStatus, string> = {
  pending: "Провайдер приймає або відхиляє",
  active: "Робота триває",
  in_review: "Клієнт перевіряє результат",
  completed: "Кошти переведені провайдеру",
  disputed: "Адмін розглядає докази",
  cancelled: "Угоду розірвано, ескроу повернуто",
};

type DealStateTrackerProps = {
  status: DealStatus;
  /** Опц.: коли активна стадія має таймер (в_review = 7d auto-complete) */
  countdown?: { label: string; expiresAt?: string };
  className?: string;
  /** Compact vertical mode для mobile/sidebar */
  variant?: "horizontal" | "vertical";
};

export function DealStateTracker({
  status,
  countdown,
  className,
  variant = "horizontal",
}: DealStateTrackerProps) {
  const isHappy = HAPPY_PATH.includes(status);
  const currentIndex = HAPPY_PATH.indexOf(status === "disputed" || status === "cancelled" ? "in_review" : status);

  if (status === "cancelled") {
    return (
      <TerminalCallout
        kind="cancelled"
        label={LABELS.cancelled}
        hint={HINTS.cancelled}
        className={className}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <ol
        className={cn(
          variant === "vertical" ? "flex flex-col gap-3" : "flex items-stretch gap-2"
        )}
      >
        {HAPPY_PATH.map((s, i) => {
          const state =
            i < currentIndex
              ? "done"
              : i === currentIndex
                ? status === "disputed"
                  ? "disputed"
                  : isHappy && status === "completed"
                    ? "done"
                    : "current"
                : "future";
          return (
            <Stage
              key={s}
              label={LABELS[s]}
              hint={HINTS[s]}
              state={state}
              index={i + 1}
              variant={variant}
            />
          );
        })}
      </ol>
      {status === "disputed" && (
        <TerminalCallout
          kind="disputed"
          label={LABELS.disputed}
          hint={HINTS.disputed}
        />
      )}
      {countdown && (
        <p className="font-mono text-caption text-muted-soft inline-flex items-center gap-1.5 self-end">
          <Clock size={12} />
          <span>
            {countdown.label}
            {countdown.expiresAt && (
              <span className="ml-1.5 text-ink-soft tabular-nums">
                {countdown.expiresAt}
              </span>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

function Stage({
  label,
  hint,
  state,
  index,
  variant,
}: {
  label: string;
  hint: string;
  state: "done" | "current" | "future" | "disputed";
  index: number;
  variant: "horizontal" | "vertical";
}) {
  if (variant === "vertical") {
    return (
      <li className="flex items-start gap-3">
        <Bullet state={state} index={index} />
        <div className="flex-1 pb-1">
          <p
            className={cn(
              "text-body leading-snug",
              state === "current"
                ? "text-ink font-medium"
                : state === "done"
                  ? "text-ink-soft"
                  : "text-muted"
            )}
          >
            {label}
          </p>
          <p className="text-caption text-muted-soft">{hint}</p>
        </div>
      </li>
    );
  }
  return (
    <li className="flex-1 min-w-0 flex flex-col gap-2">
      <span
        className={cn(
          "h-1.5 rounded-full transition-colors",
          state === "done" && "bg-ink",
          state === "current" && "bg-accent",
          state === "future" && "bg-hairline-strong",
          state === "disputed" && "bg-warning"
        )}
        aria-hidden
      />
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-mono tabular-nums border",
            state === "done" && "bg-ink text-paper border-ink",
            state === "current" && "bg-paper text-accent border-accent ring-4 ring-accent/15",
            state === "future" && "bg-paper text-muted-soft border-hairline-strong",
            state === "disputed" && "bg-warning-soft text-warning border-warning"
          )}
        >
          {state === "done" ? <Check size={10} /> : index}
        </span>
        <span
          className={cn(
            "text-caption truncate",
            state === "current" ? "text-ink font-medium" : "text-muted"
          )}
        >
          {label}
        </span>
      </div>
    </li>
  );
}

function Bullet({
  state,
  index,
}: {
  state: "done" | "current" | "future" | "disputed";
  index: number;
}) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full text-caption font-mono tabular-nums border",
        state === "done" && "bg-ink text-paper border-ink",
        state === "current" && "bg-paper text-accent border-accent ring-4 ring-accent/15",
        state === "future" && "bg-paper text-muted-soft border-hairline-strong",
        state === "disputed" && "bg-warning-soft text-warning border-warning"
      )}
    >
      {state === "done" ? <Check size={14} /> : state === "disputed" ? <AlertTriangle size={14} /> : index}
    </span>
  );
}

function TerminalCallout({
  kind,
  label,
  hint,
  className,
}: {
  kind: "disputed" | "cancelled";
  label: string;
  hint: string;
  className?: string;
}) {
  const Icon = kind === "disputed" ? AlertTriangle : X;
  return (
    <div
      className={cn(
        "flex items-start gap-3 p-4 rounded-[var(--radius-md)] border",
        kind === "disputed"
          ? "border-warning bg-warning-soft text-warning"
          : "border-danger bg-danger-soft text-danger",
        className
      )}
    >
      <Icon size={18} className="shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-body font-medium text-ink">{label}</p>
        <p className="text-caption text-ink-soft mt-0.5">{hint}</p>
      </div>
    </div>
  );
}
