"use client";
import * as React from "react";
import {
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Eye,
  Pause,
  Play,
  ChevronRight,
  TrendingUp,
  Sparkles,
  Briefcase,
  Star,
  CheckCircle2,
  AlertTriangle,
  Bell,
  Pencil,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { WalletCard } from "@/components/organisms/WalletCard";
import {
  DealStateTracker,
  type DealStatus,
} from "@/components/organisms/DealStateTracker";
import {
  NotificationItem,
  type NotificationItemData,
} from "@/components/organisms/NotificationItem";
import {
  ReviewCard,
  type ReviewCardData,
} from "@/components/organisms/ReviewCard";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { RatingStars } from "@/components/ui/RatingStars";
import { Tooltip } from "@/components/ui/Tooltip";
import { Menu, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/Menu";
import { EditorialPageHeader } from "@/components/organisms/EditorialPageHeader";
import { useRequireAuth } from "@/lib/auth";
import { useMyDeals } from "@/lib/deals";
import type { Deal } from "@/lib/deals";
import { useWallet, useTransactions, type Transaction } from "@/lib/payments";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Loader2 } from "lucide-react";

const PROVIDER_USER = {
  id: "p1",
  displayName: "Bosch Group Service",
  email: "service@bosch-group.ua",
  kycVerified: true,
  hasProviderRole: true,
};

type Period = "week" | "month" | "all";

function dealDeadlineHint(deal: Deal): string {
  // Cheap heuristic — server doesn't ship a precomputed hint for every
  // status yet. Real backend can return e.g. `auto_complete_at` or
  // `dispute_deadline_at` for the relevant statuses.
  switch (deal.status) {
    case "pending":
      return "очікує підтвердження";
    case "active":
      return deal.urgency === "today"
        ? "сьогодні"
        : deal.urgency === "tomorrow"
          ? "до завтра"
          : deal.urgency === "week"
            ? "цього тижня"
            : "за домовленістю";
    case "in_review":
      return "клієнт перевіряє";
    case "completed":
      return "завершено";
    case "disputed":
      return "відкрито диспут";
    case "cancelled":
      return "скасовано";
  }
}

function shortDealId(id: string): string {
  return `DL-${id.slice(0, 5).toUpperCase()}`;
}

type ListingRow = {
  id: string;
  title: string;
  status: "active" | "paused" | "draft" | "review";
  priceFromKopecks: number;
  unit: string;
  views30d: number;
  contacts30d: number;
  rating?: number;
  reviewsCount?: number;
  coverUrl: string;
};

const LISTINGS: ListingRow[] = [
  {
    id: "L-21847",
    title: "Ремонт пральних машин Bosch / Siemens — виїзд по Києву",
    status: "active",
    priceFromKopecks: 32000,
    unit: "/виклик",
    views30d: 4280,
    contacts30d: 184,
    rating: 4.9,
    reviewsCount: 320,
    coverUrl:
      "https://images.unsplash.com/photo-1581092335397-9583eb92d232?w=400&q=70",
  },
  {
    id: "L-21902",
    title: "Підключення посудомийних машин — гарантія 12 міс.",
    status: "active",
    priceFromKopecks: 45000,
    unit: "/виклик",
    views30d: 1820,
    contacts30d: 62,
    rating: 4.8,
    reviewsCount: 142,
    coverUrl:
      "https://images.unsplash.com/photo-1607269512643-ec0c1d2c2b95?w=400&q=70",
  },
  {
    id: "L-22014",
    title: "Сервіс холодильників Bosch / Siemens",
    status: "paused",
    priceFromKopecks: 35000,
    unit: "/виклик",
    views30d: 240,
    contacts30d: 8,
    rating: 4.7,
    reviewsCount: 28,
    coverUrl:
      "https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=400&q=70",
  },
  {
    id: "L-22120",
    title: "Чистка та сервіс кондиціонерів",
    status: "draft",
    priceFromKopecks: 60000,
    unit: "/блок",
    views30d: 0,
    contacts30d: 0,
    coverUrl:
      "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70",
  },
  {
    id: "L-22130",
    title: "Заміна ТЕНів — усі бренди пральних машин",
    status: "review",
    priceFromKopecks: 80000,
    unit: "/комплект",
    views30d: 0,
    contacts30d: 0,
    coverUrl:
      "https://images.unsplash.com/photo-1545173168-9f1947eebb7f?w=400&q=70",
  },
];

const REVIEWS: ReviewCardData[] = [
  {
    id: "r1",
    rating: 5,
    body:
      "Зателефонували — приїхали через 40 хв. Замінили підшипники у Bosch WAS, дали гарантію на 6 місяців. Усе чисто, прибрали за собою.",
    createdAt: "2026-05-08T10:11:00Z",
    author: {
      displayName: "Олена К.",
      avatarUrl: "https://i.pravatar.cc/120?img=47",
    },
    dealRef: "DL-7421",
    canReply: true,
    status: "published",
  },
  {
    id: "r2",
    rating: 4,
    body:
      "Ремонт зробили якісно, але запчастину чекали 3 дні. Майстер тримав у курсі — це плюс.",
    createdAt: "2026-05-04T09:00:00Z",
    author: { displayName: "Наталія Ш." },
    canReply: true,
    status: "published",
  },
];

const NOTIFICATIONS: NotificationItemData[] = [
  {
    id: "n1",
    code: "deal.submitted",
    aggregateType: "deal",
    title: (
      <>
        Нове замовлення від <b>Наталії Ш.</b>
      </>
    ),
    body: "Заміна ТЕНа в LG TwinWash · 750 ₴ · очікує підтвердження",
    createdAt: "2026-05-10T08:42:00Z",
    href: "#",
    mandatory: true,
    read: false,
  },
  {
    id: "n2",
    code: "payout.completed",
    aggregateType: "payout",
    title: <>Виплата 4 200 ₴ зарахована</>,
    body: "Реквізити: ····3829 · 6 травня",
    createdAt: "2026-05-06T14:00:00Z",
    href: "#",
    read: false,
  },
  {
    id: "n3",
    code: "review.submitted",
    aggregateType: "review",
    title: <>Новий відгук — 5 зірок</>,
    body: "Олена К. · «Зателефонували — приїхали через 40 хв…»",
    createdAt: "2026-05-08T10:14:00Z",
    href: "#",
    read: true,
  },
];

const KPIS: {
  label: string;
  current: string;
  delta: string;
  positive: boolean;
  hint: string;
}[] = [
  {
    label: "Виторг (30 днів)",
    current: "82 400 ₴",
    delta: "+12.4%",
    positive: true,
    hint: "vs. попередній місяць",
  },
  {
    label: "Активних угод",
    current: "07",
    delta: "+2",
    positive: true,
    hint: "за тиждень",
  },
  {
    label: "Час відповіді",
    current: "12 хв",
    delta: "−3 хв",
    positive: true,
    hint: "медіана 30 днів",
  },
  {
    label: "Рейтинг",
    current: "4.9",
    delta: "—",
    positive: true,
    hint: "320 відгуків",
  },
];

export default function ProviderDashboardPage() {
  const [period, setPeriod] = React.useState<Period>("month");
  const auth = useRequireAuth();
  const dealsState = useMyDeals({ role: "provider", limit: 20 });
  const wallet = useWallet();
  const transactions = useTransactions({ limit: 5 });

  if (!auth) {
    // Loading or redirecting — show a minimal frame
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </main>
    );
  }

  return (
    <>
      <TopNav user={PROVIDER_USER} notificationsUnread={2} messagesUnread={6} />

      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-10 pb-32 md:pb-20">
        <EditorialPageHeader
          kicker="Кабінет виконавця"
          title={
            <>
              Доброго ранку,
              <br />
              <span className="text-accent italic">Bosch Group</span>
            </>
          }
          description="7 активних угод, 2 нові запити та виплата у середу. Ось як ваш сервіс виглядає сьогодні."
          sidecar={
            <div className="flex flex-col gap-3 lg:items-end">
              <div
                role="tablist"
                aria-label="Період"
                className="inline-flex border border-hairline rounded-[var(--radius-pill)] bg-paper p-1"
              >
                {(["week", "month", "all"] as Period[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="tab"
                    aria-selected={period === p}
                    onClick={() => setPeriod(p)}
                    className={[
                      "px-4 h-8 rounded-[var(--radius-pill)] text-caption transition-colors",
                      period === p
                        ? "bg-ink text-paper"
                        : "text-muted hover:text-ink",
                    ].join(" ")}
                  >
                    {p === "week" ? "тиждень" : p === "month" ? "місяць" : "усі"}
                  </button>
                ))}
              </div>
              <Button variant="accent" leftIcon={<Plus size={14} />}>
                Нова послуга
              </Button>
            </div>
          }
        />

        {/* ============ KPI band ============ */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-12 md:mb-16">
          {KPIS.map((k) => (
            <article
              key={k.label}
              className="border border-hairline rounded-[var(--radius-md)] bg-paper p-5 md:p-6 relative overflow-hidden"
            >
              <span
                className="absolute -top-3 -right-2 font-display text-display text-canvas leading-none select-none"
                aria-hidden
              >
                {String(KPIS.indexOf(k) + 1).padStart(2, "0")}
              </span>
              <p className="relative font-mono text-micro uppercase tracking-[0.18em] text-muted">
                {k.label}
              </p>
              <p className="relative mt-2 font-display text-h1 text-ink leading-none tracking-tight tabular-nums">
                {k.current}
              </p>
              <div className="relative mt-3 flex items-center gap-2">
                <span
                  className={[
                    "inline-flex items-center gap-1 text-caption font-mono tabular-nums",
                    k.delta === "—"
                      ? "text-muted-soft"
                      : k.positive
                        ? "text-success"
                        : "text-danger",
                  ].join(" ")}
                >
                  {k.delta !== "—" &&
                    (k.positive ? (
                      <ArrowUpRight size={12} />
                    ) : (
                      <ArrowDownRight size={12} />
                    ))}
                  {k.delta}
                </span>
                <span className="text-caption text-muted">{k.hint}</span>
              </div>
            </article>
          ))}
        </section>

        {/* ============ Main grid ============ */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-10 lg:gap-12">
          {/* LEFT: Tabs */}
          <section className="min-w-0">
            <Tabs defaultValue="deals">
              <TabsList>
                <TabsTrigger
                  value="deals"
                  count={dealsState.loading ? undefined : dealsState.total}
                >
                  Угоди
                </TabsTrigger>
                <TabsTrigger value="listings" count={LISTINGS.length}>
                  Послуги
                </TabsTrigger>
                <TabsTrigger value="reviews" count={REVIEWS.length}>
                  Відгуки
                </TabsTrigger>
              </TabsList>

              <TabsContent value="deals">
                <DealsTabContent state={dealsState} />
              </TabsContent>

              <TabsContent value="listings">
                <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden mt-2">
                  <header className="hidden md:grid grid-cols-[1fr_120px_120px_140px_60px] gap-4 px-5 py-3 border-b border-hairline bg-canvas">
                    <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                      Послуга
                    </span>
                    <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted text-right">
                      Перегляди
                    </span>
                    <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted text-right">
                      Контакти
                    </span>
                    <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted text-right">
                      Ціна від
                    </span>
                    <span />
                  </header>
                  <ul className="divide-y divide-hairline">
                    {LISTINGS.map((l) => (
                      <ListingRow key={l.id} item={l} />
                    ))}
                  </ul>
                </div>
              </TabsContent>

              <TabsContent value="reviews">
                <div className="grid grid-cols-1 gap-3 mt-2">
                  {REVIEWS.map((r) => (
                    <ReviewCard
                      key={r.id}
                      data={r}
                      onReport={() => {}}
                      onReply={() => {}}
                    />
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </section>

          {/* RIGHT: rail */}
          <aside className="space-y-6">
            {wallet.loading || !wallet.data ? (
              <div className="border border-hairline rounded-[var(--radius-md)] bg-paper h-[200px] animate-pulse" />
            ) : (
              <WalletCard
                data={{
                  availableKopecks: wallet.data.available_kopecks,
                  heldKopecks: wallet.data.held_kopecks,
                  pendingPayoutKopecks: wallet.data.pending_payout_kopecks,
                }}
                onPayout={() => {}}
                onTopUp={() => {}}
              />
            )}

            <TransactionsCard state={transactions} />

            {/* Notifications */}
            <section className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
              <header className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                <h3 className="font-display text-body-lg text-ink leading-none flex items-center gap-2">
                  <Bell size={14} className="text-accent" />
                  Сповіщення
                </h3>
                <Button variant="link" size="sm">
                  Усі
                </Button>
              </header>
              <div>
                {NOTIFICATIONS.map((n) => (
                  <NotificationItem key={n.id} data={n} />
                ))}
              </div>
            </section>

            {/* Tip */}
            <div className="border border-hairline rounded-[var(--radius-md)] bg-canvas p-5 flex gap-3">
              <Sparkles size={16} className="text-accent shrink-0 mt-0.5" />
              <p className="text-caption text-ink-soft leading-relaxed">
                Послуги з 5+ фото отримують у 2.4× більше контактів. Додайте
                фото до{" "}
                <span className="text-ink font-medium">L-22120</span> &mdash;
                наразі чернетка.
              </p>
            </div>
          </aside>
        </div>
      </main>

      <Footer />
      <MobileTabBar messagesUnread={6} />
    </>
  );
}

/* ===========================================================
   Local components
   =========================================================== */

function DealsTabContent({
  state,
}: {
  state: ReturnType<typeof useMyDeals>;
}) {
  if (state.loading) {
    return (
      <div className="space-y-3 mt-2" aria-busy="true" aria-live="polite">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="border border-hairline rounded-[var(--radius-md)] bg-paper h-[96px] md:h-[104px] animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="mt-2">
        <ErrorState
          kind="server"
          variant="inline"
          description="Не вдалось завантажити список угод. Спробуйте оновити."
          onRetry={state.refresh}
        />
      </div>
    );
  }
  if (state.items.length === 0) {
    return (
      <div className="mt-2">
        <EmptyState
          numeral="00"
          size="sm"
          title="Ще немає угод"
          description="Коли клієнт відправить замовлення на одну з ваших послуг, воно зʼявиться тут — спочатку як «очікує підтвердження»."
          primaryAction={
            <Button variant="accent" leftIcon={<Plus size={14} />}>
              Нова послуга
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <>
      <div className="space-y-3 mt-2">
        {state.items.map((d) => (
          <DealCard key={d.id} deal={d} />
        ))}
      </div>
      {state.nextCursor && (
        <div className="mt-6 flex items-center justify-end">
          <Button
            variant="link"
            rightIcon={<ChevronRight size={14} />}
            onClick={state.loadMore}
            disabled={state.loadingMore}
          >
            {state.loadingMore
              ? "Завантаження…"
              : `Ще угоди (${state.total - state.items.length})`}
          </Button>
        </div>
      )}
    </>
  );
}

function TransactionsCard({
  state,
}: {
  state: ReturnType<typeof useTransactions>;
}) {
  return (
    <section className="border border-hairline rounded-[var(--radius-md)] bg-paper">
      <header className="px-5 py-4 border-b border-hairline flex items-center justify-between">
        <h3 className="font-display text-body-lg text-ink leading-none">
          Останні операції
        </h3>
        {state.nextCursor && !state.loading && (
          <Button
            variant="link"
            size="sm"
            onClick={state.loadMore}
            disabled={state.loadingMore}
          >
            {state.loadingMore ? "…" : "Ще"}
          </Button>
        )}
      </header>
      {state.loading ? (
        <ul className="divide-y divide-hairline">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="px-5 py-3 h-[64px] animate-pulse bg-paper"
            />
          ))}
        </ul>
      ) : state.error ? (
        <div className="p-5">
          <ErrorState
            kind="server"
            variant="inline"
            description="Не вдалось завантажити операції."
            onRetry={state.refresh}
          />
        </div>
      ) : state.items.length === 0 ? (
        <div className="p-6 text-center">
          <p className="text-caption text-muted leading-relaxed">
            Ще немає операцій. Вони зʼявляться, коли клієнти підтверджуватимуть
            угоди та виплатиме платформа.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {state.items.map((t) => (
            <TransactionRow key={t.id} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TransactionRow({ t }: { t: Transaction }) {
  const tone =
    t.kind === "capture"
      ? "success"
      : t.kind === "hold"
        ? "warning"
        : t.kind === "refund"
          ? "danger"
          : "neutral";
  const icon =
    t.kind === "capture" ? (
      <CheckCircle2 size={14} />
    ) : t.kind === "hold" ? (
      <TrendingUp size={14} />
    ) : t.kind === "refund" ? (
      <AlertTriangle size={14} />
    ) : (
      <ArrowUpRight size={14} />
    );
  const created = new Date(t.created_at).toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "short",
  });
  const signed = t.amount_kopecks;
  return (
    <li className="px-5 py-3 flex items-center gap-3">
      <span
        className={[
          "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] shrink-0",
          tone === "success"
            ? "bg-success-soft text-success"
            : tone === "warning"
              ? "bg-warning-soft text-warning"
              : tone === "danger"
                ? "bg-danger-soft text-danger"
                : "bg-canvas text-ink-soft",
        ].join(" ")}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink leading-tight truncate">{t.memo}</p>
        <p className="text-caption text-muted">
          {created} · {t.kind} · {t.bucket}
        </p>
      </div>
      <div
        className={[
          "font-mono tabular-nums text-body shrink-0",
          signed > 0
            ? "text-success"
            : signed < 0
              ? "text-ink-soft"
              : "text-ink-soft",
        ].join(" ")}
      >
        {signed > 0 ? "+" : signed < 0 ? "−" : ""}
        <MoneyDisplay kopecks={Math.abs(signed)} />
      </div>
    </li>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  const [expanded, setExpanded] = React.useState(deal.status === "in_review");

  const statusTone =
    deal.status === "completed"
      ? "success"
      : deal.status === "disputed"
        ? "danger"
        : deal.status === "in_review"
          ? "warning"
          : deal.status === "pending"
            ? "info"
            : "neutral";

  const statusLabel =
    deal.status === "pending"
      ? "очікує підтвердження"
      : deal.status === "active"
        ? "у роботі"
        : deal.status === "in_review"
          ? "перевірка"
          : deal.status === "completed"
            ? "завершено"
            : deal.status === "disputed"
              ? "диспут"
              : "скасовано";

  const deadlineHint = dealDeadlineHint(deal);
  const shortId = shortDealId(deal.id);

  return (
    <article className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-4 md:p-5 grid grid-cols-[1fr_auto] md:grid-cols-[auto_1fr_auto_auto] items-center gap-4 hover:bg-elevated transition-colors"
        aria-expanded={expanded}
      >
        <Avatar
          src={deal.client.avatar_url}
          alt={deal.client.display_name}
          size="md"
          className="hidden md:block"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-micro tracking-[0.18em] text-muted">
              {shortId}
            </span>
            <Badge tone={statusTone} size="sm" shape="square">
              {statusLabel}
            </Badge>
          </div>
          <h4 className="font-display text-body-lg text-ink leading-tight truncate">
            {deal.listing_title_snapshot}
          </h4>
          <p className="text-caption text-muted mt-0.5 truncate">
            {deal.client.display_name} · {deadlineHint}
          </p>
        </div>
        <div className="text-right hidden md:block shrink-0">
          <MoneyDisplay
            kopecks={deal.budget_kopecks}
            emphasize
            className="font-display text-h3 text-ink leading-none"
          />
          <p className="font-mono text-micro tracking-[0.18em] text-muted mt-1">
            від {new Date(deal.created_at).toLocaleDateString("uk-UA", { day: "numeric", month: "short" })}
          </p>
        </div>
        <ChevronRight
          size={16}
          className={[
            "text-muted shrink-0 transition-transform",
            expanded ? "rotate-90 text-ink" : "",
          ].join(" ")}
        />
      </button>

      {expanded && (
        <div className="px-4 md:px-5 pb-5 border-t border-hairline pt-5 space-y-5 bg-elevated">
          <DealStateTracker status={deal.status} variant="horizontal" />
          {deal.status === "disputed" && (
            <div className="border border-danger rounded-[var(--radius-sm)] bg-danger-soft p-4 flex items-start gap-3">
              <AlertTriangle size={16} className="text-danger shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-body text-ink leading-tight">
                  Відкрито диспут — підготуйте докази
                </p>
                <p className="text-caption text-ink-soft mt-1">
                  Деталі та можливі дії — на сторінці угоди.
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="accent"
              size="sm"
              onClick={() => {
                window.location.href = `/deals/${deal.id}`;
              }}
            >
              Відкрити угоду
            </Button>
            {deal.status === "completed" && (
              <Button variant="ghost" size="sm">
                Завантажити інвойс
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function ListingRow({ item }: { item: ListingRow }) {
  const tone =
    item.status === "active"
      ? "success"
      : item.status === "paused"
        ? "warning"
        : item.status === "review"
          ? "info"
          : "neutral";
  const label =
    item.status === "active"
      ? "опубліковано"
      : item.status === "paused"
        ? "призупинено"
        : item.status === "review"
          ? "на модерації"
          : "чернетка";

  return (
    <li className="grid grid-cols-1 md:grid-cols-[1fr_120px_120px_140px_60px] gap-4 px-5 py-4 items-center hover:bg-elevated transition-colors">
      {/* title cell */}
      <div className="flex items-start gap-3 min-w-0">
        <div
          className="h-14 w-14 rounded-[var(--radius-sm)] bg-cover bg-center border border-hairline shrink-0"
          style={{ backgroundImage: `url(${item.coverUrl})` }}
          aria-hidden
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-micro tracking-[0.18em] text-muted">
              {item.id}
            </span>
            <Badge tone={tone} size="sm" shape="square">
              {label}
            </Badge>
          </div>
          <h4 className="font-display text-body text-ink leading-tight">
            {item.title}
          </h4>
          {typeof item.rating === "number" && (
            <div className="mt-1 flex items-center gap-2 text-caption text-muted">
              <RatingStars value={item.rating} size="sm" />
              <span className="font-mono tabular-nums text-ink-soft">
                {item.rating}
              </span>
              <span>· {item.reviewsCount} відгуків</span>
            </div>
          )}
        </div>
      </div>
      {/* views */}
      <div className="text-right hidden md:block">
        <p className="font-mono tabular-nums text-body text-ink">
          {item.views30d.toLocaleString("uk-UA")}
        </p>
        <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
          30 днів
        </p>
      </div>
      <div className="text-right hidden md:block">
        <p className="font-mono tabular-nums text-body text-ink">
          {item.contacts30d}
        </p>
        <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
          контактів
        </p>
      </div>
      <div className="text-right hidden md:block">
        <MoneyDisplay
          kopecks={item.priceFromKopecks}
          emphasize
          className="font-display text-body-lg text-ink leading-none"
        />
        <p className="font-mono text-micro tracking-[0.18em] text-muted mt-1">
          {item.unit}
        </p>
      </div>
      <div className="flex items-center justify-end gap-1">
        {item.status === "active" ? (
          <Tooltip content="Призупинити">
            <Button variant="ghost" size="icon" aria-label="Pause">
              <Pause size={14} />
            </Button>
          </Tooltip>
        ) : item.status === "paused" ? (
          <Tooltip content="Відновити">
            <Button variant="ghost" size="icon" aria-label="Play">
              <Play size={14} />
            </Button>
          </Tooltip>
        ) : null}
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Меню">
              <Pencil size={14} />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem>Редагувати</MenuItem>
            <MenuItem>Дублювати</MenuItem>
            <MenuItem leftIcon={<Eye size={14} />}>Перегляд</MenuItem>
            <MenuItem leftIcon={<Briefcase size={14} />}>Перейти до угод</MenuItem>
            <MenuItem leftIcon={<Star size={14} />}>Просунути</MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}

/* unused-import guard: keep Tag in tree for future filter chips */
const _keep = Tag;
void _keep;
