import * as React from "react";
import { MapPin, Languages, ShieldCheck, Briefcase } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { RatingStars } from "@/components/ui/RatingStars";
import { Button } from "@/components/ui/Button";

export type ProviderHeaderData = {
  displayName: string;
  headline?: string;
  bio?: string;
  avatarUrl?: string;
  city?: string;
  region?: string;
  languages?: string[];
  kycVerified?: boolean;
  /** Скільки років/місяців на платформі */
  memberSince?: string;
  avgRating?: number;
  reviewsCount?: number;
  completedDealsCount?: number;
  flags?: string[];
};

type ProviderHeaderProps = {
  data: ProviderHeaderData;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
};

export function ProviderHeader({
  data,
  primaryAction,
  secondaryAction,
  className,
}: ProviderHeaderProps) {
  return (
    <header
      className={cn(
        "relative pt-10 pb-8 md:pt-14 md:pb-12 border-b border-hairline",
        className
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr_auto] gap-6 md:gap-10 items-start">
        <Avatar
          shape="circle"
          size="xl"
          alt={data.displayName}
          src={data.avatarUrl}
          kycVerified={data.kycVerified}
        />
        <div className="min-w-0">
          {data.flags && data.flags.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {data.flags.map((f) => (
                <Badge key={f} tone="accent">
                  {f}
                </Badge>
              ))}
              {data.kycVerified && (
                <Badge tone="success" withDot>
                  KYC підтверджено
                </Badge>
              )}
            </div>
          )}
          <h1 className="font-display text-h1 md:text-display text-ink tracking-tight leading-[1.05]">
            {data.displayName}
          </h1>
          {data.headline && (
            <p className="mt-3 text-body-lg text-ink-soft max-w-2xl leading-relaxed">
              {data.headline}
            </p>
          )}
          {data.bio && (
            <p className="mt-4 text-body text-muted max-w-2xl leading-relaxed">
              {data.bio}
            </p>
          )}
          <dl className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 text-caption">
            {typeof data.avgRating === "number" && (
              <div>
                <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
                  Рейтинг
                </dt>
                <dd className="mt-1">
                  <RatingStars value={data.avgRating} count={data.reviewsCount} />
                </dd>
              </div>
            )}
            {typeof data.completedDealsCount === "number" && (
              <div>
                <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
                  Завершених угод
                </dt>
                <dd className="mt-1 inline-flex items-center gap-1.5 font-display text-h3 text-ink tracking-tight tabular-nums leading-none">
                  <Briefcase size={14} className="text-muted-soft" />
                  {data.completedDealsCount}
                </dd>
              </div>
            )}
            {(data.city || data.region) && (
              <div>
                <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
                  Локація
                </dt>
                <dd className="mt-1 inline-flex items-center gap-1.5 text-ink-soft text-body">
                  <MapPin size={14} />
                  {[data.city, data.region].filter(Boolean).join(", ")}
                </dd>
              </div>
            )}
            {data.languages && data.languages.length > 0 && (
              <div>
                <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
                  Мови
                </dt>
                <dd className="mt-1 inline-flex items-center gap-1.5 text-ink-soft text-body">
                  <Languages size={14} />
                  {data.languages.join(", ")}
                </dd>
              </div>
            )}
            {data.memberSince && (
              <div>
                <dt className="font-mono text-micro uppercase tracking-loose text-muted-soft">
                  На платформі
                </dt>
                <dd className="mt-1 inline-flex items-center gap-1.5 text-ink-soft text-body">
                  <ShieldCheck size={14} />
                  {data.memberSince}
                </dd>
              </div>
            )}
          </dl>
        </div>
        <div className="md:sticky md:top-24 flex flex-row md:flex-col gap-2 md:items-stretch shrink-0 md:min-w-[200px]">
          {primaryAction ?? <Button size="lg">Звʼязатись</Button>}
          {secondaryAction}
        </div>
      </div>
    </header>
  );
}
