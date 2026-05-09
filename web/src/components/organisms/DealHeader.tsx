import * as React from "react";
import Link from "next/link";
import { Calendar, Tag as TagIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/ui/CopyButton";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import type { DealStatus } from "./DealStateTracker";

const STATUS_TONE: Record<DealStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  pending: "neutral",
  active: "info",
  in_review: "warning",
  completed: "success",
  disputed: "warning",
  cancelled: "danger",
};

const STATUS_LABEL: Record<DealStatus, string> = {
  pending: "Очікує",
  active: "Активна",
  in_review: "На перевірці",
  completed: "Завершена",
  disputed: "Спір",
  cancelled: "Скасована",
};

export type DealParty = {
  id: string;
  displayName: string;
  avatarUrl?: string;
  kycVerified?: boolean;
  /** "Клієнт" або "Провайдер" — UA */
  role: "client" | "provider";
};

export type DealHeaderData = {
  id: string;
  status: DealStatus;
  title: string;
  category?: string;
  agreedPriceKopecks: number;
  /** ISO */
  createdAt: string;
  /** ISO або null */
  deadlineAt?: string | null;
  client: DealParty;
  provider: DealParty;
  listing?: { id: string; title: string; href: string };
};

type DealHeaderProps = {
  data: DealHeaderData;
  /** Контекст хто переглядає — використовуємо для виділення «Ви» */
  viewerRole?: "client" | "provider" | "admin";
  className?: string;
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function DealHeader({ data, viewerRole, className }: DealHeaderProps) {
  return (
    <header
      className={cn(
        "border-b border-hairline pb-8 mb-8",
        className
      )}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <p className="font-mono text-micro uppercase tracking-loose text-muted-soft">
            угода
          </p>
          <CopyButton
            value={`DLR-${data.id}`}
            variant="inline"
            label={
              <span className="font-mono text-caption text-ink-soft">
                DLR-{data.id}
              </span>
            }
          />
          <Badge tone={STATUS_TONE[data.status]} withDot>
            {STATUS_LABEL[data.status]}
          </Badge>
        </div>
        <p className="font-mono text-caption text-muted-soft">
          створено {fmtDate(data.createdAt)}
        </p>
      </div>
      <h1 className="font-display text-h1 md:text-display text-ink tracking-tight leading-[1.05] mb-4">
        {data.title}
      </h1>
      {data.listing && (
        <p className="text-caption text-muted mb-6 inline-flex items-center gap-1.5">
          <TagIcon size={12} />
          За лістингом{" "}
          <Link
            href={data.listing.href}
            className="text-ink-soft underline underline-offset-4 decoration-1 hover:text-ink"
          >
            {data.listing.title}
          </Link>
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] gap-6 md:gap-8 items-stretch">
        <PartyBlock
          party={data.client}
          highlight={viewerRole === "client"}
          label="Клієнт"
        />
        <span aria-hidden className="hidden md:flex items-center justify-center text-muted-soft font-display text-h3">
          ↔
        </span>
        <PartyBlock
          party={data.provider}
          highlight={viewerRole === "provider"}
          label="Провайдер"
        />
        <div className="md:border-l md:border-hairline md:pl-8 flex flex-col justify-center">
          <p className="font-mono text-micro uppercase tracking-loose text-muted-soft">
            Сума угоди
          </p>
          <p className="font-display text-h1 md:text-h1 text-ink tracking-tight tabular-nums leading-tight mt-1">
            <MoneyDisplay kopecks={data.agreedPriceKopecks} />
          </p>
          {data.deadlineAt && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-caption text-muted">
              <Calendar size={12} /> до {fmtDate(data.deadlineAt)}
            </p>
          )}
          {data.category && (
            <p className="mt-1 text-caption text-muted-soft">{data.category}</p>
          )}
        </div>
      </div>
    </header>
  );
}

function PartyBlock({
  party,
  highlight,
  label,
}: {
  party: DealParty;
  highlight?: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar shape="circle" size="lg" alt={party.displayName} kycVerified={party.kycVerified} src={party.avatarUrl} />
      <div className="min-w-0">
        <p className="font-mono text-micro uppercase tracking-loose text-muted-soft">
          {label}
          {highlight && <span className="ml-2 text-accent">(ви)</span>}
        </p>
        <p className="font-display text-h3 text-ink tracking-tight truncate">
          {party.displayName}
        </p>
      </div>
    </div>
  );
}
