"use client";
import * as React from "react";
import { cn } from "@/lib/cn";

type TermCheckboxProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: React.ReactNode;
  body: React.ReactNode;
  /** Опц. іконка перед заголовком (Lock, ShieldCheck, тощо). */
  icon?: React.ReactNode;
  /**
   * Як виглядає рамка:
   *  - "canvas" (default): hairline на canvas-фоні, хрестик не змінює рамку
   *  - "selectable": темна рамка (border-ink) у активному стані, paper-фон
   */
  variant?: "canvas" | "selectable";
  className?: string;
};

export function TermCheckbox({
  checked,
  onChange,
  title,
  body,
  icon,
  variant = "canvas",
  className,
}: TermCheckboxProps) {
  return (
    <label
      className={cn(
        "flex items-start gap-4 border rounded-[var(--radius-md)] p-4 cursor-pointer transition-colors",
        variant === "selectable"
          ? checked
            ? "border-ink bg-paper"
            : "border-hairline bg-paper hover:border-ink-soft"
          : "border-hairline bg-canvas",
        className
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-display text-body-lg text-ink leading-tight">
          {icon && <span className="text-success">{icon}</span>}
          {title}
        </span>
        <span className="block text-caption text-muted mt-1 leading-relaxed">
          {body}
        </span>
      </span>
    </label>
  );
}
