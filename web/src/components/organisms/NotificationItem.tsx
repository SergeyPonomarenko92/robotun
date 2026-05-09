"use client";
import * as React from "react";
import Link from "next/link";
import {
  Bell,
  ShieldCheck,
  Wallet,
  AlertTriangle,
  MessageCircle,
  Briefcase,
  Star,
  Layers,
  Lock,
  CheckCircle2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";

/**
 * Module 9 — notification surface for inbox. Code-driven copy is left to caller
 * (templates лежать як code constants per Notifications v1.3); item покриває
 * presentation only.
 */
export type NotificationItemData = {
  id: string;
  /** notification_code per Notifications §4.6 */
  code: string;
  aggregateType: "deal" | "review" | "user" | "message" | "conversation" | "payment" | "payout" | "refund" | "chargeback" | "wallet" | string;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** ISO */
  createdAt: string;
  href?: string;
  /** Mandatory не можна замаркувати read через preferences, але read state — окремий */
  mandatory?: boolean;
  read?: boolean;
};

const CODE_ICON: Record<string, React.ReactNode> = {
  deal: <Briefcase size={16} />,
  review: <Star size={16} />,
  user: <ShieldCheck size={16} />,
  message: <MessageCircle size={16} />,
  conversation: <MessageCircle size={16} />,
  payment: <Wallet size={16} />,
  payout: <Wallet size={16} />,
  refund: <Wallet size={16} />,
  chargeback: <AlertTriangle size={16} />,
  wallet: <Wallet size={16} />,
};

const CODE_TONE: Record<string, string> = {
  deal: "bg-info-soft text-info",
  review: "bg-accent-soft text-accent-hover",
  user: "bg-success-soft text-success",
  message: "bg-canvas text-ink-soft",
  conversation: "bg-canvas text-ink-soft",
  payment: "bg-success-soft text-success",
  payout: "bg-success-soft text-success",
  refund: "bg-warning-soft text-warning",
  chargeback: "bg-danger-soft text-danger",
  wallet: "bg-canvas text-ink-soft",
};

function fmtRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "щойно";
  if (m < 60) return `${m} хв`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} год`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} дн`;
  return new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
}

type NotificationItemProps = {
  data: NotificationItemData;
  onMarkRead?: (id: string) => void;
  onDismiss?: (id: string) => void;
  className?: string;
};

export function NotificationItem({
  data,
  onMarkRead,
  onDismiss,
  className,
}: NotificationItemProps) {
  const Wrap = data.href ? Link : "div";
  return (
    <Wrap
      href={data.href ?? "#"}
      onClick={() => !data.read && onMarkRead?.(data.id)}
      className={cn(
        "group flex items-start gap-3 p-4 border-b border-hairline last:border-b-0 transition-colors relative",
        data.read ? "bg-paper hover:bg-elevated" : "bg-elevated hover:bg-canvas",
        className
      )}
    >
      <span
        className={cn(
          "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)]",
          CODE_TONE[data.aggregateType] ?? "bg-canvas text-ink-soft"
        )}
      >
        {CODE_ICON[data.aggregateType] ?? <Bell size={16} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <p
            className={cn(
              "text-body leading-snug truncate",
              data.read ? "text-ink-soft" : "text-ink font-medium"
            )}
          >
            {data.title}
          </p>
          <span className="font-mono text-micro text-muted-soft tabular-nums shrink-0">
            {fmtRelative(data.createdAt)}
          </span>
        </div>
        {data.body && (
          <p className="text-caption text-muted leading-relaxed mt-1 line-clamp-2">
            {data.body}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-micro uppercase tracking-loose text-muted-soft">
            {data.code}
          </span>
          {data.mandatory && (
            <Badge tone="warning" size="sm" withDot>
              <Lock size={9} /> mandatory
            </Badge>
          )}
        </div>
      </div>
      {!data.read && (
        <span
          aria-hidden
          className="absolute top-4 right-4 h-2 w-2 rounded-full bg-accent"
        />
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Прибрати"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss(data.id);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] text-muted hover:bg-canvas hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </Wrap>
  );
}

NotificationItem.MarkAllAction = function MarkAllAction({
  count,
  onMarkAll,
}: {
  count: number;
  onMarkAll: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onMarkAll}
      className="inline-flex items-center gap-1.5 text-caption text-ink-soft hover:text-ink underline underline-offset-4 decoration-1"
    >
      <CheckCircle2 size={12} /> Позначити все ({count}) як прочитане
    </button>
  );
};

NotificationItem.Layers = Layers; // re-export for icon usage in pages
