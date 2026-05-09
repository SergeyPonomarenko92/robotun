"use client";
import * as React from "react";
import { cn } from "@/lib/cn";
import { Tag } from "@/components/ui/Tag";
import { PriceRange } from "@/components/ui/PriceRange";
import { Button } from "@/components/ui/Button";

export type FilterValue = {
  priceRange: [number, number];
  cities: string[];
  ratingMin: number | null;
  kycOnly: boolean;
  withReviewsOnly: boolean;
  categories: string[];
};

type FilterPanelProps = {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  /** Доступні міста */
  cities: string[];
  /** Доступні категорії-чіпи (плоский список топ-N) */
  categories?: { id: string; label: string; count?: number }[];
  /** Межі шкали цін, копійки */
  priceMin?: number;
  priceMax?: number;
  onReset?: () => void;
  className?: string;
  /** Загальна кількість лістингів, що задовольняють фільтр (показ у CTA) */
  resultsCount?: number;
  onApply?: () => void;
};

const RATINGS = [4.5, 4, 3.5, 3];

export function FilterPanel({
  value,
  onChange,
  cities,
  categories,
  priceMin = 0,
  priceMax = 1000000,
  onReset,
  resultsCount,
  onApply,
  className,
}: FilterPanelProps) {
  const update = <K extends keyof FilterValue>(k: K, v: FilterValue[K]) =>
    onChange({ ...value, [k]: v });
  const toggle = (arr: string[], item: string) =>
    arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];

  return (
    <aside className={cn("flex flex-col gap-7", className)}>
      <Section title="Ціна">
        <PriceRange
          value={value.priceRange}
          onChange={(next) => update("priceRange", next)}
          min={priceMin}
          max={priceMax}
        />
      </Section>

      {categories && categories.length > 0 && (
        <Section title="Категорія">
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <Tag
                key={c.id}
                interactive
                selected={value.categories.includes(c.id)}
                onClick={() =>
                  update("categories", toggle(value.categories, c.id))
                }
              >
                {c.label}
                {typeof c.count === "number" && (
                  <span className="ml-1 text-muted-soft font-mono tabular-nums">
                    {c.count}
                  </span>
                )}
              </Tag>
            ))}
          </div>
        </Section>
      )}

      <Section title="Місто">
        <div className="flex flex-wrap gap-1.5">
          {cities.map((c) => (
            <Tag
              key={c}
              interactive
              selected={value.cities.includes(c)}
              onClick={() => update("cities", toggle(value.cities, c))}
              variant="soft"
            >
              {c}
            </Tag>
          ))}
        </div>
      </Section>

      <Section title="Рейтинг">
        <div className="flex flex-wrap gap-1.5">
          <Tag
            interactive
            selected={value.ratingMin === null}
            onClick={() => update("ratingMin", null)}
          >
            Будь-який
          </Tag>
          {RATINGS.map((r) => (
            <Tag
              key={r}
              interactive
              selected={value.ratingMin === r}
              onClick={() => update("ratingMin", r)}
            >
              ★ {r}+
            </Tag>
          ))}
        </div>
      </Section>

      <Section title="Безпека та якість">
        <div className="flex flex-col gap-2 text-body">
          <Toggle
            checked={value.kycOnly}
            onChange={(v) => update("kycOnly", v)}
            label="Лише KYC-перевірені"
            hint="Документи майстра підтверджено через BankID"
          />
          <Toggle
            checked={value.withReviewsOnly}
            onChange={(v) => update("withReviewsOnly", v)}
            label="Лише з відгуками"
            hint="≥1 відгук від клієнтів"
          />
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-6 px-6 pt-3 pb-4 bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/70 border-t border-hairline flex items-center justify-between gap-3">
        {onReset && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            Скинути
          </Button>
        )}
        {onApply && (
          <Button size="sm" onClick={onApply} className="ml-auto">
            {typeof resultsCount === "number"
              ? `Показати ${resultsCount}`
              : "Застосувати"}
          </Button>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-3">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <span
        className={cn(
          "shrink-0 mt-0.5 h-5 w-9 rounded-full transition-colors relative",
          checked ? "bg-ink" : "bg-hairline-strong"
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-paper transition-all duration-[var(--duration-fast)] ease-[var(--ease-standard)] shadow-xs",
            checked ? "left-4" : "left-0.5"
          )}
        />
      </span>
      <span className="flex-1">
        <span className="block text-body text-ink">{label}</span>
        {hint && <span className="block text-caption text-muted">{hint}</span>}
      </span>
    </label>
  );
}
