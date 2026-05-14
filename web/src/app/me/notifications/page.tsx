"use client";
import * as React from "react";
import { Loader2 } from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import {
  NotificationsInbox,
} from "@/components/organisms/NotificationsInbox";
import type { NotificationItemData } from "@/components/organisms/NotificationItem";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";
import { useRequireAuth } from "@/lib/auth";
import {
  useNotifications,
  markRead,
  markAllRead,
  type Notification,
} from "@/lib/notifications";

export default function NotificationsPage() {
  const auth = useRequireAuth("/login");
  const { items, error, refresh } = useNotifications();

  if (auth === null) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-canvas">
        <Loader2 size={20} className="animate-spin text-muted" />
      </main>
    );
  }

  const mapped: NotificationItemData[] = (items ?? []).map(toItemData);

  const handleMarkRead = async (id: string) => {
    try {
      await markRead(id);
      refresh();
    } catch {
      /* polling will catch up */
    }
  };
  const handleMarkAll = async () => {
    try {
      await markAllRead();
      refresh();
    } catch {
      /* polling will catch up */
    }
  };

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-3xl px-4 md:px-6 pt-6 md:pt-10 pb-20">
        <EditorialPageHeader
          kicker="Сповіщення"
          title={
            <>
              Усе важливе
              <br />
              <span className="text-ink-soft italic">в одному місці</span>
            </>
          }
          description="Угоди, відгуки, повідомлення та системні події."
        />

        <div className="mt-8">
          {error ? (
            <div className="border border-danger bg-danger-soft rounded-[var(--radius-md)] p-5">
              <div className="text-body text-ink">Не вдалось завантажити</div>
              <div className="text-caption text-muted mt-1">{error}</div>
              <button
                type="button"
                onClick={refresh}
                className="mt-3 text-caption underline text-ink hover:text-accent"
              >
                Спробувати знову
              </button>
            </div>
          ) : items === null ? (
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper h-40 flex items-center justify-center">
              <Loader2 size={18} className="animate-spin text-muted" />
            </div>
          ) : (
            <NotificationsInbox
              items={mapped}
              onMarkRead={handleMarkRead}
              onMarkAllRead={handleMarkAll}
            />
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}

function toItemData(n: Notification): NotificationItemData {
  return {
    id: n.id,
    code: n.notification_code,
    aggregateType: n.aggregate_type,
    title: n.title,
    body: n.body ?? undefined,
    createdAt: n.created_at,
    href: n.href ?? undefined,
    mandatory: n.mandatory,
    read: n.read_at !== null,
  };
}
