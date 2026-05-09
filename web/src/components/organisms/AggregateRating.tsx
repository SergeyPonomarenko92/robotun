import * as React from "react";
import { cn } from "@/lib/cn";
import { RatingStars } from "@/components/ui/RatingStars";

export type RatingDistribution = {
  /** {5: 120, 4: 45, 3: 12, 2: 4, 1: 2} */
  [stars: number]: number;
};

type AggregateRatingProps = {
  /** 0..5 */
  avgRating: number;
  /** Загалом */
  totalCount: number;
  distribution: RatingDistribution;
  className?: string;
};

export function AggregateRating({
  avgRating,
  totalCount,
  distribution,
  className,
}: AggregateRatingProps) {
  const max = Math.max(...Object.values(distribution), 1);
  return (
    <section
      className={cn(
        "border border-hairline rounded-[var(--radius-md)] bg-paper p-6 md:p-8",
        "grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 md:gap-10 items-center",
        className
      )}
    >
      <div className="text-center md:text-left">
        <p className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-2">
          Загальний рейтинг
        </p>
        <p className="font-display text-display text-ink tracking-tight tabular-nums leading-none">
          {avgRating.toFixed(1)}
        </p>
        <div className="mt-3 flex items-center md:justify-start justify-center gap-2">
          <RatingStars value={avgRating} size="md" showZero={false} />
        </div>
        <p className="mt-2 font-mono text-caption text-muted tabular-nums">
          {totalCount} {totalCount === 1 ? "відгук" : totalCount < 5 ? "відгуки" : "відгуків"}
        </p>
      </div>
      <div className="md:border-l md:border-hairline md:pl-10">
        <ul className="flex flex-col gap-2">
          {[5, 4, 3, 2, 1].map((stars) => {
            const count = distribution[stars] ?? 0;
            const pct = totalCount > 0 ? (count / totalCount) * 100 : 0;
            const fillPct = max > 0 ? (count / max) * 100 : 0;
            return (
              <li key={stars} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-caption">
                <span className="font-mono tabular-nums text-ink-soft inline-flex items-center gap-1.5">
                  <span className="w-3 text-right">{stars}</span>★
                </span>
                <span className="h-2 rounded-full bg-canvas border border-hairline overflow-hidden" aria-hidden>
                  <span
                    className="block h-full bg-ink transition-[width] duration-[var(--duration-base)]"
                    style={{ width: `${fillPct}%` }}
                  />
                </span>
                <span className="font-mono tabular-nums text-muted-soft text-right min-w-[3rem]">
                  {count} · {pct.toFixed(0)}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
