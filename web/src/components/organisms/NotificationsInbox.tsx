"use client";
import * as React from "react";
import { cn } from "@/lib/cn";
import {
  NotificationItem,
  type NotificationItemData,
} from "./NotificationItem";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { Inbox, Bell } from "lucide-react";

type NotificationsInboxProps = {
  items: NotificationItemData[];
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  onDismiss?: (id: string) => void;
  className?: string;
};

const TAB_GROUPS: { id: string; label: string; types?: string[] }[] = [
  { id: "all", label: "Усі" },
  { id: "deals", label: "Угоди", types: ["deal", "payment", "payout", "refund", "chargeback", "wallet"] },
  { id: "reviews", label: "Відгуки", types: ["review"] },
  { id: "messages", label: "Чати", types: ["message", "conversation"] },
  { id: "system", label: "Система", types: ["user"] },
];

export function NotificationsInbox({
  items,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  className,
}: NotificationsInboxProps) {
  const unreadCount = items.filter((i) => !i.read).length;
  return (
    <section className={cn("border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden", className)}>
      <header className="flex items-center justify-between px-4 py-4 border-b border-hairline">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-canvas text-ink-soft">
            <Bell size={16} />
          </span>
          <div>
            <h2 className="font-display text-h3 text-ink tracking-tight leading-none">Сповіщення</h2>
            <p className="text-caption text-muted-soft mt-0.5 font-mono tabular-nums">
              {unreadCount > 0 ? `${unreadCount} нових` : "усе прочитано"}
            </p>
          </div>
        </div>
        {onMarkAllRead && (
          <NotificationItem.MarkAllAction count={unreadCount} onMarkAll={onMarkAllRead} />
        )}
      </header>

      <Tabs defaultValue="all">
        <div className="px-4 pt-3">
          <TabsList className="border-b-0">
            {TAB_GROUPS.map((g) => {
              const groupItems = !g.types
                ? items
                : items.filter((i) => g.types!.includes(i.aggregateType));
              const groupUnread = groupItems.filter((i) => !i.read).length;
              return (
                <TabsTrigger key={g.id} value={g.id} count={groupUnread || undefined}>
                  {g.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
        {TAB_GROUPS.map((g) => {
          const groupItems = !g.types
            ? items
            : items.filter((i) => g.types!.includes(i.aggregateType));
          return (
            <TabsContent key={g.id} value={g.id} className="pt-0!">
              {groupItems.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    size="sm"
                    icon={<Inbox size={20} />}
                    title="Поки нічого нового"
                    description="Тут зʼявлятимуться сповіщення про угоди, повідомлення й відгуки."
                  />
                </div>
              ) : (
                <ul>
                  {groupItems.map((it) => (
                    <li key={it.id}>
                      <NotificationItem
                        data={it}
                        onMarkRead={onMarkRead}
                        onDismiss={onDismiss}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </section>
  );
}
