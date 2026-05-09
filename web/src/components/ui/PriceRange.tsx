"use client";
import * as React from "react";
import * as Slider from "@radix-ui/react-slider";
import { cn } from "@/lib/cn";
import { MoneyInput, MoneyDisplay } from "./MoneyInput";

/**
 * Двозубний діапазон ціни в копійках (UAH-only). Використовується у фільтрах
 * Feed/Search. Значення завжди в копійках (BIGINT) для консистентності з
 * Listings/Deal API.
 */
type PriceRangeProps = {
  /** [min, max] копійок */
  value: [number, number];
  onChange: (next: [number, number]) => void;
  /** межі шкали */
  min: number;
  max: number;
  /** крок (копійки) */
  step?: number;
  className?: string;
  /** показувати поля для ручного вводу */
  withInputs?: boolean;
};

export function PriceRange({
  value,
  onChange,
  min,
  max,
  step = 5000,
  className,
  withInputs = true,
}: PriceRangeProps) {
  const [v0, v1] = value;
  return (
    <div className={cn("w-full flex flex-col gap-3", className)}>
      <div className="flex items-baseline justify-between">
        <p className="text-caption text-muted">Ціна</p>
        <p className="text-caption text-ink-soft font-mono tabular-nums">
          <MoneyDisplay kopecks={v0} /> — <MoneyDisplay kopecks={v1} />
        </p>
      </div>
      <Slider.Root
        value={value}
        onValueChange={(next) => onChange([next[0], next[1]] as [number, number])}
        min={min}
        max={max}
        step={step}
        minStepsBetweenThumbs={1}
        className="relative flex items-center select-none touch-none w-full h-5"
      >
        <Slider.Track className="bg-hairline relative grow rounded-full h-[3px]">
          <Slider.Range className="absolute bg-ink rounded-full h-full" />
        </Slider.Track>
        {[0, 1].map((i) => (
          <Slider.Thumb
            key={i}
            aria-label={i === 0 ? "Мінімальна ціна" : "Максимальна ціна"}
            className="block h-5 w-5 rounded-full bg-paper border-2 border-ink shadow-sm hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
        ))}
      </Slider.Root>
      {withInputs && (
        <div className="grid grid-cols-2 gap-2">
          <MoneyInput
            size="sm"
            valueKopecks={v0}
            minKopecks={min}
            maxKopecks={v1}
            onChangeKopecks={(k) => onChange([k ?? min, v1])}
          />
          <MoneyInput
            size="sm"
            valueKopecks={v1}
            minKopecks={v0}
            maxKopecks={max}
            onChangeKopecks={(k) => onChange([v0, k ?? max])}
          />
        </div>
      )}
    </div>
  );
}
