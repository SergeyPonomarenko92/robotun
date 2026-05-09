"use client";
import * as React from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE: Record<
  Tone,
  { icon: React.ReactNode; cls: string }
> = {
  success: { icon: <CheckCircle2 size={18} />, cls: "border-success bg-success-soft text-success" },
  warning: { icon: <AlertTriangle size={18} />, cls: "border-warning bg-warning-soft text-warning" },
  danger: { icon: <XCircle size={18} />, cls: "border-danger bg-danger-soft text-danger" },
  info: { icon: <Info size={18} />, cls: "border-info bg-info-soft text-info" },
  neutral: { icon: <Info size={18} />, cls: "border-hairline-strong bg-paper text-ink" },
};

type InlineAlertProps = {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
  /** «Sticky» banner варіант — тонкий рядок без рамки, для top of page */
  variant?: "card" | "banner";
};

export function InlineAlert({
  tone = "info",
  title,
  children,
  action,
  onDismiss,
  className,
  variant = "card",
}: InlineAlertProps) {
  const t = TONE[tone];
  if (variant === "banner") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-2.5 border-b text-caption",
          t.cls,
          className
        )}
      >
        <span className="shrink-0 opacity-90">{t.icon}</span>
        <p className="flex-1 min-w-0 text-ink">
          {title && <strong className="mr-1.5">{title}</strong>}
          {children}
        </p>
        {action && <span className="shrink-0">{action}</span>}
        {onDismiss && (
          <button
            type="button"
            aria-label="Закрити"
            onClick={onDismiss}
            className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-xs)] text-current opacity-70 hover:opacity-100 hover:bg-current/10"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 p-4 rounded-[var(--radius-md)] border",
        t.cls,
        className
      )}
    >
      <span className="shrink-0 mt-0.5">{t.icon}</span>
      <div className="flex-1 min-w-0">
        {title && (
          <p className="font-sans font-medium text-ink leading-snug mb-0.5">
            {title}
          </p>
        )}
        {children && <div className="text-caption text-ink-soft leading-relaxed">{children}</div>}
        {action && <div className="mt-3 flex items-center gap-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="Закрити"
          onClick={onDismiss}
          className="shrink-0 -mt-1 -mr-1 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] text-current opacity-70 hover:opacity-100 hover:bg-current/10"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
