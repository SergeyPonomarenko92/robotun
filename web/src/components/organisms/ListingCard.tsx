"use client";
import * as React from "react";
import Link from "next/link";
import { MapPin, Heart, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { RatingStars } from "@/components/ui/RatingStars";
import { MoneyDisplay } from "@/components/ui/MoneyInput";

export type ListingCardData = {
  id: string;
  href: string;
  title: string;
  coverUrl: string;
  /** Ціна "від" у копійках */
  priceFromKopecks: number;
  /** Постфікс ціни: '/год' / '/послуга' / '' */
  priceUnit?: string;
  city?: string;
  region?: string;
  category?: string;
  provider: {
    name: string;
    avatarUrl?: string;
    kycVerified?: boolean;
    avgRating?: number;
    reviewsCount?: number;
    completedDealsCount?: number;
  };
  /** "Топ-провайдер", "Новий" і подібні плашки */
  flags?: string[];
  /** SLA / response */
  responseTime?: string;
  saved?: boolean;
};

type Variant = "feed" | "row" | "compact";

type ListingCardProps = {
  data: ListingCardData;
  variant?: Variant;
  onSaveToggle?: (id: string, next: boolean) => void;
  className?: string;
};

export function ListingCard({
  data,
  variant = "feed",
  onSaveToggle,
  className,
}: ListingCardProps) {
  const {
    id,
    href,
    title,
    coverUrl,
    priceFromKopecks,
    priceUnit,
    city,
    region,
    category,
    provider,
    flags,
    responseTime,
    saved,
  } = data;

  if (variant === "row") {
    return (
      <article
        className={cn(
          "group flex gap-4 p-3 rounded-[var(--radius-md)] border border-hairline bg-paper hover:border-ink hover:shadow-md transition-[border,box-shadow]",
          className
        )}
      >
        <Link href={href} className="block shrink-0 relative h-32 w-32 md:h-36 md:w-44 rounded-[var(--radius-sm)] overflow-hidden bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverUrl} alt={title} className="h-full w-full object-cover" />
        </Link>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <Link href={href} className="min-w-0 group-hover:underline underline-offset-4 decoration-1">
              <h3 className="font-display text-h3 text-ink tracking-tight truncate">
                {title}
              </h3>
            </Link>
            <SaveButton id={id} saved={saved} onToggle={onSaveToggle} />
          </div>
          <div className="flex items-center gap-2 mt-1 text-caption text-muted">
            {category && <span>{category}</span>}
            {(city || region) && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} />
                  {[city, region].filter(Boolean).join(", ")}
                </span>
              </>
            )}
            {responseTime && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock size={12} />
                  {responseTime}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Avatar size="sm" shape="circle" alt={provider.name} src={provider.avatarUrl} kycVerified={provider.kycVerified} />
            <span className="text-caption text-ink-soft truncate">{provider.name}</span>
            {typeof provider.avgRating === "number" && (
              <RatingStars
                size="sm"
                value={provider.avgRating}
                count={provider.reviewsCount}
                showZero={false}
              />
            )}
          </div>
          <div className="mt-auto pt-3 flex items-end justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {flags?.map((f) => (
                <Badge key={f} tone="accent" size="sm">{f}</Badge>
              ))}
            </div>
            <PriceLabel kopecks={priceFromKopecks} unit={priceUnit} />
          </div>
        </div>
      </article>
    );
  }

  if (variant === "compact") {
    return (
      <Link
        href={href}
        className={cn(
          "group flex gap-3 p-3 rounded-[var(--radius-sm)] hover:bg-canvas transition-colors",
          className
        )}
      >
        <span className="shrink-0 h-14 w-14 rounded-[var(--radius-xs)] overflow-hidden bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverUrl} alt={title} className="h-full w-full object-cover" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-body text-ink truncate group-hover:underline underline-offset-2 decoration-1">
            {title}
          </span>
          <span className="block text-caption text-muted truncate">
            {category}
          </span>
          <span className="block mt-0.5 font-mono text-caption text-ink-soft tabular-nums">
            від <MoneyDisplay kopecks={priceFromKopecks} />
            {priceUnit && <span className="text-muted-soft">{priceUnit}</span>}
          </span>
        </span>
      </Link>
    );
  }

  // feed (default)
  return (
    <article
      className={cn(
        "group flex flex-col rounded-[var(--radius-md)] border border-hairline bg-paper overflow-hidden hover:border-ink hover:shadow-md transition-[border,box-shadow]",
        className
      )}
    >
      <Link href={href} className="block relative aspect-[4/3] overflow-hidden bg-canvas">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverUrl}
          alt={title}
          className="h-full w-full object-cover transition-transform duration-[var(--duration-slow)] group-hover:scale-[1.02]"
        />
        {flags && flags.length > 0 && (
          <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
            {flags.map((f) => (
              <Badge key={f} tone="ink" shape="square" size="sm">{f}</Badge>
            ))}
          </div>
        )}
        <div className="absolute top-2 right-2">
          <SaveButton id={id} saved={saved} onToggle={onSaveToggle} variant="overlay" />
        </div>
      </Link>
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-start justify-between gap-3">
          <Link href={href} className="min-w-0 group-hover:underline underline-offset-4 decoration-1">
            <h3 className="font-display text-h3 text-ink tracking-tight leading-tight line-clamp-2">
              {title}
            </h3>
          </Link>
          <PriceLabel kopecks={priceFromKopecks} unit={priceUnit} compact />
        </div>
        <div className="flex items-center gap-2 text-caption text-muted">
          {category && <span>{category}</span>}
          {(city || region) && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} />
                {[city, region].filter(Boolean).join(", ")}
              </span>
            </>
          )}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-3 border-t border-hairline">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar size="sm" shape="circle" alt={provider.name} src={provider.avatarUrl} kycVerified={provider.kycVerified} />
            <span className="text-caption text-ink-soft truncate">{provider.name}</span>
          </div>
          {typeof provider.avgRating === "number" && (
            <RatingStars
              size="sm"
              value={provider.avgRating}
              count={provider.reviewsCount}
              showZero={false}
            />
          )}
        </div>
      </div>
    </article>
  );
}

function PriceLabel({
  kopecks,
  unit,
  compact,
}: {
  kopecks: number;
  unit?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("text-right shrink-0", compact && "text-right")}>
      <p className="font-mono text-caption text-muted-soft uppercase tracking-loose leading-none">
        від
      </p>
      <p className="font-display text-h3 text-ink tracking-tight tabular-nums leading-tight">
        <MoneyDisplay kopecks={kopecks} />
        {unit && <span className="text-muted-soft text-body ml-1">{unit}</span>}
      </p>
    </div>
  );
}

function SaveButton({
  id,
  saved,
  onToggle,
  variant = "default",
}: {
  id: string;
  saved?: boolean;
  onToggle?: (id: string, next: boolean) => void;
  variant?: "default" | "overlay";
}) {
  return (
    <button
      type="button"
      aria-label={saved ? "Прибрати зі збережених" : "Зберегти"}
      aria-pressed={saved}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle?.(id, !saved);
      }}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] transition-colors",
        variant === "overlay"
          ? "bg-paper/90 backdrop-blur text-ink-soft hover:text-accent hover:bg-paper"
          : "text-muted hover:text-accent",
        saved && "text-accent"
      )}
    >
      <Heart size={16} fill={saved ? "currentColor" : "none"} />
    </button>
  );
}
