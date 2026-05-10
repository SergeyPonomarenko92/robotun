import * as React from "react";
import { cn } from "@/lib/cn";

type EditorialPageHeaderProps = {
  /** Маленький моно-заголовок над h1 */
  kicker?: React.ReactNode;
  /**
   * Основний титул. Для editorial-vibe передавайте JSX з <br/> і
   * <span className="text-accent italic | text-ink-soft italic"/> для
   * акцентного рядка.
   */
  title: React.ReactNode;
  /** Опціональний lead-параграф під h1 */
  description?: React.ReactNode;
  /** Колонка справа: меню періоду, status badge, vital stats, дії */
  sidecar?: React.ReactNode;
  /** Як вирівнювати baseline колонок: end (за замовчуванням, для коротких sidecar) або start */
  align?: "end" | "start";
  className?: string;
};

export function EditorialPageHeader({
  kicker,
  title,
  description,
  sidecar,
  align = "end",
  className,
}: EditorialPageHeaderProps) {
  return (
    <header
      className={cn(
        "grid grid-cols-12 gap-x-6 gap-y-6 mb-10 md:mb-14",
        align === "end" ? "items-end" : "items-start",
        className
      )}
    >
      <div className={cn("col-span-12", sidecar ? "lg:col-span-8" : "lg:col-span-12")}>
        {kicker && (
          <p className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-3">
            {kicker}
          </p>
        )}
        <h1 className="font-display text-h1 md:text-display text-ink leading-[0.98] tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="mt-5 text-body-lg text-ink-soft max-w-xl leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {sidecar && <aside className="col-span-12 lg:col-span-4">{sidecar}</aside>}
    </header>
  );
}
