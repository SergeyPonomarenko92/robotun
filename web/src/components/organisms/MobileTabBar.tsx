"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, Plus, MessageCircle, User } from "lucide-react";
import { cn } from "@/lib/cn";
import { CountBadge } from "@/components/ui/CountBadge";

type MobileTabBarProps = {
  messagesUnread?: number;
  notificationsUnread?: number;
  className?: string;
};

const TABS = [
  { href: "/", label: "Стрічка", icon: Home },
  { href: "/search", label: "Пошук", icon: Search },
  { href: "/create", label: "Створити", icon: Plus, accent: true },
  { href: "/messages", label: "Чати", icon: MessageCircle, badgeKey: "messagesUnread" as const },
  { href: "/profile", label: "Профіль", icon: User },
];

export function MobileTabBar({
  messagesUnread = 0,
  notificationsUnread = 0,
  className,
}: MobileTabBarProps) {
  const pathname = usePathname();
  return (
    <nav
      className={cn(
        "md:hidden fixed bottom-0 inset-x-0 z-[var(--z-sticky)] bg-canvas/90 backdrop-blur supports-[backdrop-filter]:bg-canvas/70 border-t border-hairline",
        "pb-[env(safe-area-inset-bottom)]",
        className
      )}
      aria-label="Основна навігація"
    >
      <ul className="grid grid-cols-5 h-16">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = pathname === t.href || (t.href !== "/" && pathname?.startsWith(t.href));
          const badge =
            t.badgeKey === "messagesUnread"
              ? messagesUnread
              : t.badgeKey === undefined
                ? 0
                : 0;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                className={cn(
                  "h-full w-full flex flex-col items-center justify-center gap-1 text-[11px] relative transition-colors",
                  active
                    ? t.accent
                      ? "text-accent"
                      : "text-ink"
                    : "text-muted hover:text-ink"
                )}
                aria-current={active ? "page" : undefined}
              >
                <span
                  className={cn(
                    "relative inline-flex items-center justify-center",
                    t.accent &&
                      "h-9 w-9 rounded-full bg-accent text-paper -mt-3 shadow-md"
                  )}
                >
                  <Icon size={t.accent ? 18 : 20} strokeWidth={t.accent ? 2 : 1.75} />
                  {badge > 0 && !t.accent && (
                    <span className="absolute -top-1 -right-1.5">
                      <CountBadge value={badge} tone="accent" />
                    </span>
                  )}
                </span>
                <span className={cn(t.accent && "sr-only")}>{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {/* keep notificationsUnread reserved for future tab; suppress unused var warning */}
      <span className="sr-only" aria-hidden>
        {notificationsUnread}
      </span>
    </nav>
  );
}
