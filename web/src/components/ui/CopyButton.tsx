"use client";
import * as React from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/cn";

type CopyButtonProps = {
  value: string;
  /** Текст для відображення поряд (опц.) */
  label?: React.ReactNode;
  /** Що показати в tooltip-snackbar після успіху */
  successLabel?: string;
  size?: "sm" | "md";
  className?: string;
  /** Стиль: ghost (icon-only) | inline (label + icon) */
  variant?: "ghost" | "inline";
};

export function CopyButton({
  value,
  label,
  successLabel = "Скопійовано",
  size = "md",
  className,
  variant = "ghost",
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore — старі браузери */
    }
  }

  const dim = size === "sm" ? "h-7 px-2 text-caption" : "h-8 px-2.5 text-body";

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={copy}
        className={cn(
          "inline-flex items-center gap-1.5 font-mono text-ink-soft hover:text-ink transition-colors group",
          className
        )}
      >
        {label ?? value}
        <span className="opacity-50 group-hover:opacity-100 transition-opacity">
          {copied ? <Check size={size === "sm" ? 12 : 14} /> : <Copy size={size === "sm" ? 12 : 14} />}
        </span>
        {copied && (
          <span className="ml-1 text-caption text-success">{successLabel}</span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? successLabel : "Копіювати"}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-sm)] text-ink-soft hover:bg-canvas hover:text-ink transition-colors",
        dim,
        copied && "text-success bg-success-soft hover:bg-success-soft hover:text-success",
        className
      )}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
