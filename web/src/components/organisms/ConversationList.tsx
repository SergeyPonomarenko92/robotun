"use client";
import * as React from "react";
import Link from "next/link";
import { Search, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { CountBadge } from "@/components/ui/CountBadge";
import { Input } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";

export type ConversationItem = {
  id: string;
  href: string;
  /** Інша сторона (НЕ-я) */
  counterparty: { displayName: string; avatarUrl?: string; kycVerified?: boolean };
  /** Module 10: 'pre_deal' (через listing) | 'deal' */
  scope: "pre_deal" | "deal";
  /** Snippet останнього повідомлення */
  lastMessage?: { body?: string | null; senderIsMe?: boolean; gdprErased?: boolean; redacted?: boolean };
  lastMessageAt?: string;
  unreadCount?: number;
  /** Контекст: лістинг або угода */
  context?: { label: string; href?: string };
  /** Заблоковано (auto-block contact-info) */
  blocked?: boolean;
};

type ConversationListProps = {
  items: ConversationItem[];
  activeId?: string;
  scopeFilter?: "all" | "pre_deal" | "deal";
  onScopeFilterChange?: (next: "all" | "pre_deal" | "deal") => void;
  searchValue?: string;
  onSearchChange?: (next: string) => void;
  className?: string;
};

function fmtRelative(iso?: string) {
  if (!iso) return "";
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

export function ConversationList({
  items,
  activeId,
  scopeFilter = "all",
  onScopeFilterChange,
  searchValue,
  onSearchChange,
  className,
}: ConversationListProps) {
  const filtered =
    scopeFilter === "all" ? items : items.filter((c) => c.scope === scopeFilter);

  return (
    <aside
      className={cn(
        "flex flex-col h-full border-r border-hairline bg-paper min-w-0",
        className
      )}
    >
      <header className="p-4 border-b border-hairline flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-h3 text-ink tracking-tight">Чати</h2>
          <span className="font-mono text-caption text-muted-soft tabular-nums">
            {filtered.length}
          </span>
        </div>
        <Input
          size="sm"
          placeholder="Шукати в чатах"
          leftAddon={<Search size={14} />}
          value={searchValue}
          onChange={(e) => onSearchChange?.(e.target.value)}
        />
        {onScopeFilterChange && (
          <div className="flex gap-1.5">
            <Tag interactive size="sm" selected={scopeFilter === "all"} onClick={() => onScopeFilterChange("all")}>
              Усі
            </Tag>
            <Tag interactive size="sm" selected={scopeFilter === "deal"} onClick={() => onScopeFilterChange("deal")}>
              По угодах
            </Tag>
            <Tag interactive size="sm" selected={scopeFilter === "pre_deal"} onClick={() => onScopeFilterChange("pre_deal")}>
              До угоди
            </Tag>
          </div>
        )}
      </header>
      <ul className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="p-8 text-center text-caption text-muted">
            Немає чатів за цим фільтром.
          </li>
        ) : (
          filtered.map((c) => {
            const active = c.id === activeId;
            const unread = c.unreadCount ?? 0;
            const snippet = c.lastMessage?.gdprErased
              ? "[повідомлення видалено]"
              : c.lastMessage?.redacted
                ? "[повідомлення приховано модератором]"
                : c.lastMessage?.body ?? "";
            return (
              <li key={c.id} className="border-b border-hairline last:border-b-0">
                <Link
                  href={c.href}
                  className={cn(
                    "flex gap-3 p-4 transition-colors",
                    active ? "bg-canvas" : "hover:bg-elevated"
                  )}
                  aria-current={active ? "true" : undefined}
                >
                  <Avatar
                    shape="circle"
                    size="md"
                    alt={c.counterparty.displayName}
                    src={c.counterparty.avatarUrl}
                    kycVerified={c.counterparty.kycVerified}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <p
                        className={cn(
                          "text-body truncate",
                          unread > 0 ? "font-medium text-ink" : "text-ink-soft"
                        )}
                      >
                        {c.counterparty.displayName}
                      </p>
                      <span className="font-mono text-micro text-muted-soft tabular-nums shrink-0">
                        {fmtRelative(c.lastMessageAt)}
                      </span>
                    </div>
                    {c.context && (
                      <p className="text-micro font-mono uppercase tracking-loose text-muted-soft truncate mt-0.5">
                        {c.scope === "deal" ? "угода" : "лістинг"} · {c.context.label}
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-2 min-w-0">
                      {c.blocked && (
                        <span className="inline-flex items-center gap-1 text-caption text-danger shrink-0">
                          <Lock size={11} /> заблоковано
                        </span>
                      )}
                      <p
                        className={cn(
                          "text-caption truncate flex-1 min-w-0",
                          unread > 0 ? "text-ink-soft" : "text-muted",
                          (c.lastMessage?.gdprErased || c.lastMessage?.redacted) && "italic"
                        )}
                      >
                        {c.lastMessage?.senderIsMe && !c.lastMessage?.gdprErased && (
                          <span className="text-muted-soft">Ви: </span>
                        )}
                        {snippet}
                      </p>
                      {unread > 0 && (
                        <CountBadge value={unread} tone="accent" />
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}
