"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";
import { useRequireAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";

type QueueCounts = { disputes: number; payouts: number; audit: number };

function useAdminQueueCounts(enabled: boolean): QueueCounts | null {
  const [counts, setCounts] = React.useState<QueueCounts | null>(null);
  const pathname = usePathname();
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    apiFetch<QueueCounts>("/admin/queue-counts")
      .then((c) => {
        if (alive) setCounts(c);
      })
      .catch(() => {
        if (alive) setCounts({ disputes: 0, payouts: 0, audit: 0 });
      });
    return () => {
      alive = false;
    };
  }, [enabled, pathname]);
  return counts;
}

type TabId = "disputes" | "payouts" | "kyc" | "users" | "listings" | "audit";
type PipKind = "backlog" | "activity";
type TabDef = {
  id: TabId;
  href: string;
  label: string;
  count?: number;
  /** 'backlog' = work-to-do counter (accent on active), 'activity' = passive
   *  24h activity indicator (muted on both states). Defaults to 'backlog'. */
  pipKind?: PipKind;
};

function AdminTabBar({ counts }: { counts: QueueCounts | null }) {
  const pathname = usePathname();
  const active: TabId | null = pathname.startsWith("/admin/disputes")
    ? "disputes"
    : pathname.startsWith("/admin/payouts")
      ? "payouts"
      : pathname.startsWith("/admin/kyc")
        ? "kyc"
        : pathname.startsWith("/admin/users")
          ? "users"
          : pathname.startsWith("/admin/listings")
            ? "listings"
            : pathname.startsWith("/admin/audit")
              ? "audit"
              : null;

  const tabs: TabDef[] = [
    { id: "disputes", href: "/admin/disputes", label: "Диспути", count: counts?.disputes },
    { id: "payouts", href: "/admin/payouts", label: "Виплати", count: counts?.payouts },
    { id: "kyc", href: "/admin/kyc", label: "KYC" },
    { id: "users", href: "/admin/users", label: "Користувачі" },
    { id: "listings", href: "/admin/listings", label: "Лоти" },
    { id: "audit", href: "/admin/audit", label: "Журнал", count: counts?.audit, pipKind: "activity" },
  ];

  return (
    <nav
      aria-label="Адмін-навігація"
      className="border-b border-hairline bg-canvas"
    >
      <div className="mx-auto max-w-6xl px-4 md:px-6">
        <ul
          className="flex overflow-x-auto -mb-px gap-0 [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: "none" }}
        >
          {tabs.map((tab) => {
            const isActive = active === tab.id;
            return (
              <li key={tab.id} className="shrink-0">
                <Link
                  href={tab.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-2 px-4 py-3.5 text-body whitespace-nowrap",
                    "border-b-2 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
                    isActive
                      ? "border-accent text-ink font-medium"
                      : "border-transparent text-muted hover:text-ink hover:border-hairline-strong"
                  )}
                >
                  <span>{tab.label}</span>
                  {tab.count != null && tab.count > 0 && (
                    <span
                      aria-label={
                        tab.pipKind === "activity"
                          ? `${tab.count} подій за добу`
                          : `${tab.count} активних`
                      }
                      className={cn(
                        "inline-flex items-center justify-center",
                        "min-w-[1.25rem] h-5 px-1.5 rounded-[var(--radius-pill)]",
                        "font-mono text-micro tabular-nums leading-none",
                        // Activity pip stays muted on both states — it's not a
                        // backlog so accent-tone would mis-signal urgency.
                        tab.pipKind === "activity"
                          ? "bg-ink/10 text-ink-soft"
                          : isActive
                            ? "bg-accent text-paper"
                            : "bg-ink/10 text-ink-soft"
                      )}
                    >
                      {tab.count > 99 ? "99+" : tab.count}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

export type AdminShellProps = {
  kicker: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  sidecar?: React.ReactNode;
  children: React.ReactNode;
};

export function AdminShell({
  kicker,
  title,
  description,
  sidecar,
  children,
}: AdminShellProps) {
  const auth = useRequireAuth("/login");
  const router = useRouter();

  const isAdmin = !!auth && auth.user.roles.includes("admin");
  const counts = useAdminQueueCounts(isAdmin);

  React.useEffect(() => {
    if (auth && !auth.user.roles.includes("admin")) {
      router.replace("/");
    }
  }, [auth, router]);

  // Auth still loading → spinner. Authenticated-but-not-admin → render nothing
  // (the effect above triggers redirect; suppressing render avoids FOUC).
  if (auth === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="min-h-screen flex items-center justify-center bg-canvas"
      >
        <Loader2 size={20} className="animate-spin text-muted" aria-hidden="true" />
        <span className="sr-only">Перевірка прав доступу…</span>
      </div>
    );
  }
  if (!isAdmin) return null;

  return (
    <>
      <TopNav />
      <AdminTabBar counts={counts} />
      <main className="mx-auto max-w-6xl px-4 md:px-6 pt-6 md:pt-10 pb-20">
        <EditorialPageHeader
          kicker={kicker}
          title={title}
          description={description}
          sidecar={sidecar}
        />
        {children}
      </main>
      <Footer />
    </>
  );
}
