"use client";
import * as React from "react";
import { Calendar, Clock } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Simple wrapper над native input[type=date|datetime-local|time].
 * Контракт: ISO-string значення (`YYYY-MM-DD` або `YYYY-MM-DDTHH:MM`).
 * Calendar UI lives у браузері — для MVP цього достатньо. Custom calendar
 * popover (react-day-picker) — окремий апгрейд.
 */
type Variant = "date" | "datetime" | "time";

type DateTimePickerProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "size"
> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  tone?: "neutral" | "error" | "success";
};

const TYPE_MAP: Record<Variant, string> = {
  date: "date",
  datetime: "datetime-local",
  time: "time",
};

const ICON_MAP: Record<Variant, React.ReactNode> = {
  date: <Calendar size={16} />,
  datetime: <Calendar size={16} />,
  time: <Clock size={16} />,
};

export const DateTimePicker = React.forwardRef<
  HTMLInputElement,
  DateTimePickerProps
>(function DateTimePicker(
  { className, variant = "date", size = "md", tone = "neutral", ...props },
  ref
) {
  const sizeCls =
    size === "sm" ? "h-8 text-caption" : size === "lg" ? "h-12 text-body-lg" : "h-10 text-body";
  const borderTone =
    tone === "error"
      ? "border-danger focus-within:border-danger"
      : tone === "success"
        ? "border-success focus-within:border-success"
        : "border-hairline-strong focus-within:border-ink";
  return (
    <div
      className={cn(
        "flex items-stretch w-full bg-paper border rounded-[var(--radius-sm)] transition-colors",
        borderTone,
        className
      )}
    >
      <span className="flex items-center pl-3 pr-2 text-muted">
        {ICON_MAP[variant]}
      </span>
      <input
        ref={ref}
        type={TYPE_MAP[variant]}
        className={cn(
          "flex-1 bg-transparent border-0 outline-none text-ink font-mono tabular-nums px-2 pr-3",
          sizeCls
        )}
        {...props}
      />
    </div>
  );
});
