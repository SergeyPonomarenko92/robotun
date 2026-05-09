import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";

/**
 * Module 12 admin unified queue row. Source-aware (kyc / dispute / listing /
 * review / chargeback / appeal / report). Per Admin §4.* — row renders source
 * badge, severity, claim status, age.
 */
export type AdminQueueSource =
  | "kyc"
  | "dispute"
  | "listing"
  | "review"
  | "chargeback"
  | "appeal"
  | "report"
  | "category"
  | "feedback"
  | "abuse";

const SOURCE_LABEL: Record<AdminQueueSource, string> = {
  kyc: "KYC",
  dispute: "Спір",
  listing: "Лістинг",
  review: "Відгук",
  chargeback: "Чарджбек",
  appeal: "Апеляція",
  report: "Скарга",
  category: "Категорія",
  feedback: "Фідбек",
  abuse: "Зловживання",
};

const SOURCE_TONE: Record<AdminQueueSource, "neutral" | "info" | "warning" | "danger" | "accent" | "success" | "ink"> = {
  kyc: "info",
  dispute: "warning",
  listing: "neutral",
  review: "accent",
  chargeback: "danger",
  appeal: "warning",
  report: "danger",
  category: "neutral",
  feedback: "neutral",
  abuse: "danger",
};

export type Severity = "P0" | "P1" | "P2" | "P3";

const SEVERITY_TONE: Record<Severity, string> = {
  P0: "bg-danger text-paper border-danger",
  P1: "bg-warning text-paper border-warning",
  P2: "bg-info text-paper border-info",
  P3: "bg-canvas text-muted border-hairline-strong",
};

export type AdminQueueItem = {
  id: string;
  source: AdminQueueSource;
  severity: Severity;
  /** Заголовок (e.g. "Спір по DLR-9af3 · Bosch Group") */
  title: string;
  /** Скорочений опис */
  summary?: string;
  /** ISO */
  createdAt: string;
  /** Заявлений SLA-deadline ISO */
  dueAt?: string;
  /** Хто claim'нув; null/undef = не claim'нуто */
  claimedBy?: { name: string; avatarUrl?: string } | null;
  /** Power-user link */
  href: string;
  /** Опц. tag-list (e.g. "Київ", "повторне", "P&L") */
  tags?: string[];
};

type AdminQueueRowProps = {
  item: AdminQueueItem;
  /** Можна claim: якщо null → claim button; якщо інший адмін → "вже взято" */
  selfId?: string;
  onClaim?: (id: string) => void;
  className?: string;
};

function fmtRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} хв тому`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} год тому`;
  const d = Math.floor(h / 24);
  return `${d} дн тому`;
}

function dueIn(iso?: string) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: "прострочено", urgent: true };
  const h = Math.floor(ms / 3600000);
  if (h < 24) return { text: `за ${h} год`, urgent: h < 4 };
  return { text: `за ${Math.floor(h / 24)} дн`, urgent: false };
}

export function AdminQueueRow({ item, selfId, onClaim, className }: AdminQueueRowProps) {
  const due = dueIn(item.dueAt);
  const claimedBySelf = item.claimedBy && selfId && item.claimedBy.name === selfId;
  return (
    <article
      className={cn(
        "grid grid-cols-[auto_1fr_auto] gap-4 items-center px-4 py-3 border-b border-hairline last:border-b-0 hover:bg-canvas transition-colors",
        className
      )}
    >
      <div className="flex flex-col items-center gap-1.5 min-w-[44px]">
        <span
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] font-mono text-micro font-medium border",
            SEVERITY_TONE[item.severity]
          )}
          aria-label={`Severity ${item.severity}`}
        >
          {item.severity}
        </span>
        <Badge tone={SOURCE_TONE[item.source]} size="sm" shape="square">
          {SOURCE_LABEL[item.source]}
        </Badge>
      </div>
      <Link href={item.href} className="min-w-0">
        <p className="font-sans text-body text-ink leading-snug font-medium truncate group-hover:underline">
          {item.title}
        </p>
        {item.summary && (
          <p className="text-caption text-muted truncate mt-0.5">{item.summary}</p>
        )}
        <div className="mt-1.5 flex items-center gap-3 flex-wrap text-micro font-mono uppercase tracking-loose text-muted-soft">
          <span>{fmtRelative(item.createdAt)}</span>
          {due && (
            <>
              <span aria-hidden>·</span>
              <span className={cn(due.urgent && "text-danger")}>SLA {due.text}</span>
            </>
          )}
          {item.tags?.map((t) => (
            <span key={t} className="border border-hairline px-1.5 py-0.5 rounded-[var(--radius-xs)] normal-case tracking-normal">
              {t}
            </span>
          ))}
        </div>
      </Link>
      <div className="flex items-center gap-2 shrink-0">
        {item.claimedBy ? (
          <span className="inline-flex items-center gap-2 text-caption text-muted">
            <Avatar size="xs" alt={item.claimedBy.name} src={item.claimedBy.avatarUrl} />
            <span className="truncate max-w-[80px]">
              {claimedBySelf ? "ваше" : item.claimedBy.name}
            </span>
          </span>
        ) : onClaim ? (
          <button
            type="button"
            onClick={() => onClaim(item.id)}
            className="text-caption font-medium text-ink hover:text-accent underline underline-offset-4 decoration-1"
          >
            Взяти
          </button>
        ) : null}
        <ChevronRight size={14} className="text-muted-soft" />
      </div>
    </article>
  );
}
