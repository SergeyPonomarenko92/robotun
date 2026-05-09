"use client";
import * as React from "react";
import { cn } from "@/lib/cn";

type FormFieldProps = {
  id?: string;
  label?: React.ReactNode;
  helper?: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  charCount?: { current: number; max: number };
  className?: string;
  children: React.ReactElement;
};

const Ctx = React.createContext<{ id: string; describedBy?: string; tone?: "neutral" | "error" } | null>(
  null
);

export function FormField({
  id,
  label,
  helper,
  error,
  hint,
  required,
  optional,
  charCount,
  className,
  children,
}: FormFieldProps) {
  const reactId = React.useId();
  const inputId = id ?? `ff-${reactId}`;
  const describedById = error
    ? `${inputId}-error`
    : helper
      ? `${inputId}-helper`
      : undefined;
  const tone: "neutral" | "error" = error ? "error" : "neutral";

  const child = React.cloneElement(children, {
    id: inputId,
    "aria-describedby": describedById,
    "aria-invalid": error ? true : undefined,
    tone: (children.props as { tone?: string }).tone ?? tone,
  } as Record<string, unknown>);

  return (
    <Ctx.Provider value={{ id: inputId, describedBy: describedById, tone }}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        {(label || hint) && (
          <div className="flex items-baseline justify-between gap-3">
            {label && (
              <label htmlFor={inputId} className="text-caption text-ink-soft font-medium">
                {label}
                {required && (
                  <span aria-hidden className="text-accent ml-0.5">
                    *
                  </span>
                )}
                {optional && (
                  <span className="text-muted-soft font-normal ml-1.5">
                    (необов’язково)
                  </span>
                )}
              </label>
            )}
            {hint && <span className="text-micro text-muted-soft">{hint}</span>}
          </div>
        )}
        {child}
        <div className="flex items-start justify-between gap-3 min-h-[16px]">
          {error ? (
            <p id={`${inputId}-error`} className="text-caption text-danger leading-snug">
              {error}
            </p>
          ) : helper ? (
            <p id={`${inputId}-helper`} className="text-caption text-muted leading-snug">
              {helper}
            </p>
          ) : (
            <span />
          )}
          {charCount && (
            <span
              className={cn(
                "text-micro font-mono shrink-0 tabular-nums",
                charCount.current > charCount.max ? "text-danger" : "text-muted-soft"
              )}
            >
              {charCount.current}/{charCount.max}
            </span>
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function useFormField() {
  return React.useContext(Ctx);
}
