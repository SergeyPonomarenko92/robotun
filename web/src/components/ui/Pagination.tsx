"use client";
import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

/**
 * Cursor-keyset pagination: спеки (Feed §8, Search §13) використовують keyset cursor,
 * не offset. Цей компонент рендерить «Завантажити ще» + лічильник + (опц.) IntersectionObserver
 * для авто-завантаження при наближенні до низу. Жодних номерних сторінок.
 */
type PaginationProps = {
  /** Чи є ще одна сторінка (cursor not null) */
  hasMore: boolean;
  /** Завантажується наступна сторінка */
  loading?: boolean;
  /** Скільки вже завантажено */
  loaded: number;
  /** Загальна кількість (опц., якщо backend повертає) */
  total?: number;
  onLoadMore: () => void;
  /** Авто-довантаження при перетині низу */
  autoLoad?: boolean;
  className?: string;
};

export function Pagination({
  hasMore,
  loading,
  loaded,
  total,
  onLoadMore,
  autoLoad = false,
  className,
}: PaginationProps) {
  const sentinel = React.useRef<HTMLDivElement>(null);
  const handlerRef = React.useRef(onLoadMore);
  handlerRef.current = onLoadMore;

  React.useEffect(() => {
    if (!autoLoad || !hasMore || loading) return;
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) handlerRef.current();
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [autoLoad, hasMore, loading]);

  return (
    <div className={cn("flex flex-col items-center gap-3 py-8", className)}>
      <p className="font-mono text-caption text-muted-soft tabular-nums">
        {loaded}
        {typeof total === "number" && (
          <span className="text-muted-soft/70"> / {total}</span>
        )}
        <span className="ml-1.5 text-muted-soft/70 normal-case">показано</span>
      </p>
      {hasMore ? (
        <>
          <Button
            variant="secondary"
            onClick={onLoadMore}
            loading={loading}
            leftIcon={loading ? undefined : <span aria-hidden>↓</span>}
          >
            {loading ? "Завантаження…" : "Завантажити ще"}
          </Button>
          <div ref={sentinel} aria-hidden className="h-1 w-1" />
        </>
      ) : (
        <p className="text-caption text-muted-soft italic">— це все —</p>
      )}
      {loading && autoLoad && (
        <Loader2 className="animate-spin text-muted" size={16} aria-hidden />
      )}
    </div>
  );
}
