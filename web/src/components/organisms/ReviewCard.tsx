"use client";
import * as React from "react";
import { MoreHorizontal, Flag, Reply } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { RatingStars } from "@/components/ui/RatingStars";
import { Menu, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/Menu";

export type ReviewCardData = {
  id: string;
  rating: number;
  body: string;
  createdAt: string;
  /** автор (клієнт що залишив відгук) */
  author: { displayName: string; avatarUrl?: string };
  /** Опц.: контекст лістингу/угоди */
  dealRef?: string;
  /** Module 7: provider reply within 30d */
  reply?: { body: string; createdAt: string };
  attachments?: { id: string; thumbUrl: string; alt?: string }[];
  /** Module 7: report / status */
  status?: "published" | "pending_takedown" | "removed";
  /** Поточний viewer може писати reply (=провайдер) */
  canReply?: boolean;
};

type ReviewCardProps = {
  data: ReviewCardData;
  onReport?: () => void;
  onReply?: () => void;
  className?: string;
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function ReviewCard({ data, onReport, onReply, className }: ReviewCardProps) {
  const removed = data.status === "removed";
  return (
    <article
      className={cn(
        "border border-hairline rounded-[var(--radius-md)] bg-paper p-5 md:p-6",
        removed && "opacity-60",
        className
      )}
    >
      <header className="flex items-start gap-3 mb-3">
        <Avatar shape="circle" size="md" alt={data.author.displayName} src={data.author.avatarUrl} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-display text-body-lg text-ink tracking-tight truncate">
              {data.author.displayName}
            </p>
            <span className="font-mono text-caption text-muted-soft tabular-nums shrink-0">
              {fmtDate(data.createdAt)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <RatingStars value={data.rating} size="sm" showZero={false} />
            {data.dealRef && (
              <span className="font-mono text-micro text-muted-soft uppercase tracking-loose">
                · {data.dealRef}
              </span>
            )}
            {data.status === "pending_takedown" && (
              <Badge tone="warning" size="sm">розглядається скарга</Badge>
            )}
            {data.status === "removed" && (
              <Badge tone="danger" size="sm">видалено</Badge>
            )}
          </div>
        </div>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="Дії"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:text-ink hover:bg-canvas"
            >
              <MoreHorizontal size={16} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {data.canReply && !data.reply && (
              <MenuItem leftIcon={<Reply size={14} />} onSelect={() => onReply?.()}>
                Відповісти
              </MenuItem>
            )}
            <MenuItem destructive leftIcon={<Flag size={14} />} onSelect={() => onReport?.()}>
              Поскаржитися
            </MenuItem>
          </MenuContent>
        </Menu>
      </header>

      {removed ? (
        <p className="text-body text-muted italic">[відгук видалено модератором]</p>
      ) : (
        <p className="text-body text-ink-soft leading-relaxed whitespace-pre-line">
          {data.body}
        </p>
      )}

      {data.attachments && data.attachments.length > 0 && !removed && (
        <ul className="mt-3 grid grid-cols-3 md:grid-cols-5 gap-1.5">
          {data.attachments.map((a) => (
            <li key={a.id} className="aspect-square rounded-[var(--radius-xs)] overflow-hidden bg-canvas border border-hairline">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.thumbUrl} alt={a.alt ?? ""} className="h-full w-full object-cover" />
            </li>
          ))}
        </ul>
      )}

      {data.reply && (
        <div className="mt-4 pt-4 border-t border-hairline">
          <p className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-2 inline-flex items-center gap-1.5">
            <Reply size={11} /> Відповідь провайдера · {fmtDate(data.reply.createdAt)}
          </p>
          <p className="text-body text-ink-soft leading-relaxed">{data.reply.body}</p>
        </div>
      )}
    </article>
  );
}
