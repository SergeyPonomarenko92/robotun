"use client";
import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { InlineAlert } from "@/components/ui/InlineAlert";

type WizardSheetProps = {
  /** 1-based step number, рендериться як "01", "02" перед заголовком */
  index: number;
  title: React.ReactNode;
  /** Опц. іконка перед заголовком (FileText, Camera, тощо) */
  icon?: React.ReactNode;
  /** Чи валідний поточний крок — впливає на бейдж справа в шапці */
  valid?: boolean;
  /** Список помилок поточного кроку (рендеряться у InlineAlert внизу) */
  errors?: string[];
  /**
   * Бейдж справа в шапці. За замовчуванням — "готово" (success) при valid,
   * "у роботі" (warning) при !valid. Передайте власний node щоб override,
   * або `null` щоб приховати.
   */
  statusBadge?: React.ReactNode | null;
  className?: string;
  children: React.ReactNode;
};

export function WizardSheet({
  index,
  title,
  icon,
  valid = true,
  errors,
  statusBadge,
  className,
  children,
}: WizardSheetProps) {
  return (
    <article
      className={cn(
        "border border-hairline rounded-[var(--radius-md)] bg-paper",
        className
      )}
    >
      <header className="flex items-center justify-between gap-3 px-6 md:px-8 py-5 border-b border-hairline">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-micro uppercase tracking-[0.22em] text-accent shrink-0">
            {String(index).padStart(2, "0")}
          </span>
          {icon && <span className="text-accent shrink-0">{icon}</span>}
          <h2 className="font-display text-h2 text-ink tracking-tight leading-tight truncate">
            {title}
          </h2>
        </div>
        {statusBadge === undefined
          ? valid
            ? (
              <span className="hidden md:inline-flex items-center gap-1 text-caption text-success">
                <Check size={14} />
                готово
              </span>
            )
            : (
              <span className="hidden md:inline-flex items-center gap-1 text-caption text-warning">
                у роботі
              </span>
            )
          : statusBadge}
      </header>

      <div className="p-6 md:p-8">{children}</div>

      {errors && errors.length > 0 && (
        <div className="px-6 md:px-8 pb-6">
          <InlineAlert tone="warning" title="Перевірте поля кроку">
            <ul className="list-disc ml-4 space-y-0.5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </InlineAlert>
        </div>
      )}
    </article>
  );
}
