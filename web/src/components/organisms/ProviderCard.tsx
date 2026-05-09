import * as React from "react";
import Link from "next/link";
import { MapPin, Briefcase } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { RatingStars } from "@/components/ui/RatingStars";
import { MoneyDisplay } from "@/components/ui/MoneyInput";

export type ProviderCardData = {
  id: string;
  href: string;
  displayName: string;
  headline?: string;
  avatarUrl?: string;
  city?: string;
  kycVerified?: boolean;
  avgRating?: number;
  reviewsCount?: number;
  completedDealsCount?: number;
  /** Ціна від, копійки */
  priceFromKopecks?: number;
  /** Підказка типу "топ-1% у Києві" */
  badgeLabel?: string;
};

type ProviderCardProps = {
  data: ProviderCardData;
  variant?: "card" | "row";
  className?: string;
};

export function ProviderCard({ data, variant = "card", className }: ProviderCardProps) {
  if (variant === "row") {
    return (
      <Link
        href={data.href}
        className={cn(
          "group flex items-center gap-4 p-3 rounded-[var(--radius-md)] hover:bg-canvas transition-colors",
          className
        )}
      >
        <Avatar shape="circle" size="lg" alt={data.displayName} src={data.avatarUrl} kycVerified={data.kycVerified} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-display text-h3 text-ink tracking-tight truncate group-hover:underline underline-offset-4 decoration-1">
              {data.displayName}
            </h3>
            {typeof data.avgRating === "number" && (
              <RatingStars size="sm" value={data.avgRating} count={data.reviewsCount} showZero={false} />
            )}
          </div>
          {data.headline && (
            <p className="text-caption text-muted truncate mt-0.5">{data.headline}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-caption text-muted">
            {data.city && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} />
                {data.city}
              </span>
            )}
            {typeof data.completedDealsCount === "number" && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                  <Briefcase size={12} />
                  {data.completedDealsCount} угод
                </span>
              </>
            )}
            {data.badgeLabel && (
              <>
                <span aria-hidden>·</span>
                <Badge tone="accent" size="sm">{data.badgeLabel}</Badge>
              </>
            )}
          </div>
        </div>
        {typeof data.priceFromKopecks === "number" && (
          <div className="text-right shrink-0">
            <p className="font-mono text-micro uppercase tracking-loose text-muted-soft leading-none">від</p>
            <p className="font-display text-h3 text-ink tracking-tight tabular-nums leading-tight">
              <MoneyDisplay kopecks={data.priceFromKopecks} />
            </p>
          </div>
        )}
      </Link>
    );
  }
  return (
    <Link
      href={data.href}
      className={cn(
        "group flex flex-col rounded-[var(--radius-md)] border border-hairline bg-paper p-5 hover:border-ink hover:shadow-md transition-[border,box-shadow]",
        className
      )}
    >
      <div className="flex items-start gap-3 mb-4">
        <Avatar shape="circle" size="lg" alt={data.displayName} src={data.avatarUrl} kycVerified={data.kycVerified} />
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-h3 text-ink tracking-tight truncate group-hover:underline underline-offset-4 decoration-1">
            {data.displayName}
          </h3>
          {data.headline && (
            <p className="text-caption text-muted line-clamp-2 mt-0.5">{data.headline}</p>
          )}
        </div>
      </div>
      {typeof data.avgRating === "number" && (
        <div className="mb-3">
          <RatingStars value={data.avgRating} count={data.reviewsCount} />
        </div>
      )}
      <dl className="grid grid-cols-2 gap-3 text-caption mb-4">
        {data.city && (
          <div>
            <dt className="text-muted-soft uppercase tracking-loose font-mono text-micro">Місто</dt>
            <dd className="text-ink-soft mt-0.5">{data.city}</dd>
          </div>
        )}
        {typeof data.completedDealsCount === "number" && (
          <div>
            <dt className="text-muted-soft uppercase tracking-loose font-mono text-micro">Угод</dt>
            <dd className="text-ink-soft mt-0.5 font-mono tabular-nums">{data.completedDealsCount}</dd>
          </div>
        )}
      </dl>
      {data.badgeLabel && <Badge tone="accent">{data.badgeLabel}</Badge>}
    </Link>
  );
}
