import * as React from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion, Clock } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Module 4 KYC statuses (see spec-architecture-kyc-provider-verification.md):
 *   not_started | submitted | approved | rejected | expired | rekyc_required | suspended
 */
export type KYCStatus =
  | "not_started"
  | "submitted"
  | "approved"
  | "rejected"
  | "expired"
  | "rekyc_required"
  | "suspended";

const META: Record<
  KYCStatus,
  { icon: React.ReactNode; label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }
> = {
  not_started: { icon: <ShieldQuestion size={14} />, label: "KYC не пройдено", tone: "neutral" },
  submitted: { icon: <Clock size={14} />, label: "На перевірці", tone: "info" },
  approved: { icon: <ShieldCheck size={14} />, label: "KYC підтверджено", tone: "success" },
  rejected: { icon: <ShieldAlert size={14} />, label: "Відхилено", tone: "danger" },
  expired: { icon: <ShieldAlert size={14} />, label: "Прострочено", tone: "warning" },
  rekyc_required: { icon: <ShieldAlert size={14} />, label: "Потрібен повторний KYC", tone: "warning" },
  suspended: { icon: <ShieldAlert size={14} />, label: "Призупинено", tone: "danger" },
};

const TONE_CLS: Record<"neutral" | "info" | "success" | "warning" | "danger", string> = {
  neutral: "bg-canvas text-ink-soft border-hairline-strong",
  info: "bg-info-soft text-info border-info",
  success: "bg-success-soft text-success border-success",
  warning: "bg-warning-soft text-warning border-warning",
  danger: "bg-danger-soft text-danger border-danger",
};

type KYCStatusBadgeProps = {
  status: KYCStatus;
  /** Якщо approved — показуємо expires_at countdown */
  expiresAt?: string;
  className?: string;
  size?: "sm" | "md";
};

export function KYCStatusBadge({
  status,
  expiresAt,
  className,
  size = "md",
}: KYCStatusBadgeProps) {
  const m = META[status];
  const dim = size === "sm" ? "h-6 px-2 text-caption" : "h-7 px-2.5 text-caption";
  const expiry = expiresAt ? formatExpiry(expiresAt) : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border rounded-[var(--radius-pill)] font-medium",
        TONE_CLS[m.tone],
        dim,
        className
      )}
    >
      {m.icon}
      <span>{m.label}</span>
      {expiry && (
        <span className="font-mono text-micro tabular-nums text-current/70 ml-1">
          · до {expiry}
        </span>
      )}
    </span>
  );
}

function formatExpiry(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "минув";
  const days = Math.ceil(ms / 86_400_000);
  if (days < 31) return `${days} дн`;
  return new Date(iso).toLocaleDateString("uk-UA", { month: "short", year: "2-digit" });
}
