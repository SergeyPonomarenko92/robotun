"use client";
import * as React from "react";
import { useParams } from "next/navigation";
import {
  Loader2,
  MapPin,
  Phone,
  Lock,
  Calendar,
  Receipt,
  ShieldCheck,
} from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { DealHeader } from "@/components/organisms/DealHeader";
import { DealStateTracker } from "@/components/organisms/DealStateTracker";
import { DealActionsPanel } from "@/components/organisms/DealActionsPanel";

import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { MoneyDisplay } from "@/components/ui/MoneyInput";
import { ErrorState } from "@/components/ui/ErrorState";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

import { useRequireAuth } from "@/lib/auth";
import {
  useDeal,
  transitionDeal,
  type Deal,
  type DealAction,
} from "@/lib/deals";

export default function DealPage() {
  const auth = useRequireAuth("/login");
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const deal = useDeal(id);

  if (!auth) return <PageLoader />;
  if (deal.loading) return <PageLoader />;
  if (deal.notFound) {
    return (
      <PageFrame>
        <ErrorState
          kind="not_found"
          title="Угоду не знайдено"
          description="Можливо, її було видалено або URL змінився."
          variant="page"
        />
      </PageFrame>
    );
  }
  if (deal.error || !deal.data) {
    return (
      <PageFrame>
        <ErrorState
          kind="server"
          title="Не вдалось завантажити угоду"
          onRetry={() => window.location.reload()}
        />
      </PageFrame>
    );
  }

  return <DealView deal={deal.data} viewerId={auth.user.id} />;
}

function PageLoader() {
  return (
    <PageFrame>
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    </PageFrame>
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav notificationsUnread={0} messagesUnread={0} />
      <main className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-32">
        {children}
      </main>
      <Footer />
      <MobileTabBar />
    </>
  );
}

function DealView({ deal, viewerId }: { deal: Deal; viewerId: string }) {
  const role: "client" | "provider" | "admin" =
    viewerId === deal.client_id
      ? "client"
      : viewerId === deal.provider_id
        ? "provider"
        : "admin";

  const [pendingAction, setPendingAction] = React.useState<DealAction | null>(
    null
  );
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [current, setCurrent] = React.useState<Deal>(deal);

  // Keep local state in sync if parent refetches
  React.useEffect(() => setCurrent(deal), [deal]);

  // ---- transition handlers ----
  const onAction = (id: string) => {
    setActionError(null);
    if (id === "accept" || id === "reject" || id === "cancel") {
      setPendingAction(id);
    } else {
      // Other action ids belong to states beyond MVP wiring (dispute, submit
      // for review, etc.) — out of scope for this round.
      setActionError(
        "Ця дія ще не пов'язана з бекендом — буде додано наступним кроком."
      );
    }
  };
  const confirmAction = async () => {
    if (!pendingAction || busy) return;
    setBusy(true);
    const result = await transitionDeal(current.id, pendingAction);
    setBusy(false);
    if (result.ok) {
      setCurrent(result.deal);
      setPendingAction(null);
    } else {
      setActionError(result.error.message);
      setPendingAction(null);
    }
  };

  return (
    <>
      <TopNav notificationsUnread={0} messagesUnread={0} />
      <main className="mx-auto max-w-7xl px-4 md:px-6 pt-6 md:pt-8 pb-20">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "Угоди", href: "#" },
            { label: current.id.slice(0, 8) },
          ]}
        />

        <DealHeader
          viewerRole={role}
          data={{
            id: current.id,
            status: current.status,
            title: current.listing_title_snapshot,
            agreedPriceKopecks: current.budget_kopecks,
            createdAt: current.created_at,
            deadlineAt: current.deadline_at,
            client: {
              id: current.client.id,
              displayName: current.client.display_name,
              avatarUrl: current.client.avatar_url,
              kycVerified: current.client.kyc_verified,
              role: "client",
            },
            provider: {
              id: current.provider.id,
              displayName: current.provider.display_name,
              avatarUrl: current.provider.avatar_url,
              kycVerified: current.provider.kyc_verified,
              role: "provider",
            },
            listing: {
              id: current.listing_id,
              title: current.listing_title_snapshot,
              href: `/listings/${current.listing_id}`,
            },
          }}
        />

        <div className="mb-12">
          <DealStateTracker
            status={current.status}
            countdown={
              current.status === "pending"
                ? { label: "Очікує підтвердження виконавцем" }
                : current.status === "active" && current.deadline_at
                  ? {
                      label: "Дедлайн",
                      expiresAt: current.deadline_at,
                    }
                  : undefined
            }
          />
        </div>

        {actionError && (
          <div className="mb-6">
            <InlineAlert tone="warning" title="Дію не виконано">
              {actionError}
            </InlineAlert>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-10">
          {/* LEFT: details */}
          <section className="space-y-8 min-w-0">
            <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
              <h2 className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-4">
                Бриф
              </h2>
              <p className="text-body text-ink-soft leading-relaxed whitespace-pre-line">
                {current.scope}
              </p>
            </article>

            <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
              <h2 className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-4">
                Координати
              </h2>
              <dl className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-5 gap-y-3">
                <DetailRow
                  icon={<MapPin size={14} />}
                  label="Адреса"
                  value={current.address}
                />
                <DetailRow
                  icon={<Phone size={14} />}
                  label="Телефон"
                  value={
                    role === "admin" ||
                    role === "provider" ||
                    role === "client"
                      ? current.phone
                      : "—"
                  }
                />
                <DetailRow
                  icon={<Calendar size={14} />}
                  label="Створено"
                  value={fmtDate(current.created_at)}
                />
                {current.deadline_at && (
                  <DetailRow
                    icon={<Calendar size={14} />}
                    label="Дедлайн"
                    value={fmtDate(current.deadline_at)}
                  />
                )}
                <DetailRow
                  icon={<ShieldCheck size={14} />}
                  label="Терміновість"
                  value={URGENCY_LABEL[current.urgency]}
                />
              </dl>
            </article>

            <article className="border border-hairline rounded-[var(--radius-md)] bg-paper p-6">
              <h2 className="font-mono text-micro uppercase tracking-[0.22em] text-accent mb-4">
                Сторони
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <PartyCard
                  party={current.client}
                  roleLabel="Клієнт"
                  isYou={role === "client"}
                />
                <PartyCard
                  party={current.provider}
                  roleLabel="Виконавець"
                  isYou={role === "provider"}
                />
              </div>
            </article>
          </section>

          {/* RIGHT: amount + actions */}
          <aside className="space-y-4 lg:sticky lg:top-24 self-start">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
              <header className="px-5 py-4 border-b border-hairline flex items-center gap-2">
                <Receipt size={14} className="text-accent" />
                <span className="font-mono text-micro uppercase tracking-[0.22em] text-muted">
                  Ескроу
                </span>
              </header>
              <dl className="p-5 space-y-2 text-body">
                <Row label="Бюджет">
                  <MoneyDisplay kopecks={current.budget_kopecks} />
                </Row>
                <Row label="Сервісний збір">
                  +<MoneyDisplay kopecks={current.fee_kopecks} />
                </Row>
                <div className="border-t border-hairline pt-2 mt-2 flex items-baseline justify-between">
                  <span className="font-display text-body-lg text-ink">
                    Заморожено
                  </span>
                  <span className="font-display text-body-lg text-ink font-mono tabular-nums">
                    <MoneyDisplay kopecks={current.total_held_kopecks} />
                  </span>
                </div>
                <p className="font-mono text-micro tracking-[0.18em] text-muted-soft">
                  hold_id&nbsp;<span className="text-ink-soft">{current.hold_id}</span>
                </p>
              </dl>
              <div className="px-5 py-4 border-t border-hairline flex items-start gap-3">
                <Lock size={14} className="text-success shrink-0 mt-0.5" />
                <p className="text-caption text-muted leading-relaxed">
                  Кошти на платформі. Виконавець отримає виплату лише після
                  підтвердження роботи клієнтом.
                </p>
              </div>
            </div>

            <DealActionsPanel
              status={current.status}
              role={role}
              onAction={onAction}
            />
          </aside>
        </div>
      </main>

      {/* Confirm action modal */}
      <Modal
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
        title={
          pendingAction === "accept"
            ? "Прийняти угоду?"
            : pendingAction === "reject"
              ? "Відхилити угоду?"
              : "Скасувати запит?"
        }
        description={
          pendingAction === "accept"
            ? "Підтверджуючи, ви беретесь виконати роботу за зазначеним брифом."
            : pendingAction === "reject"
              ? "Кошти повернуться клієнту негайно. Ця дія незворотна."
              : "Кошти повернуться вам. Виконавець більше не побачить запит."
        }
        size="md"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPendingAction(null)}
              disabled={busy}
            >
              Назад
            </Button>
            <Button
              variant={pendingAction === "accept" ? "accent" : "danger"}
              loading={busy}
              onClick={confirmAction}
            >
              {pendingAction === "accept"
                ? "Так, прийняти"
                : pendingAction === "reject"
                  ? "Так, відхилити"
                  : "Так, скасувати"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-body text-ink-soft leading-relaxed">
          <p>
            Стан угоди оновиться миттєво для обох сторін. Усі дії зберігаються
            у журналі змін.
          </p>
        </div>
      </Modal>

      <Footer />
      <MobileTabBar />
    </>
  );
}

/* ---------- helpers ---------- */

const URGENCY_LABEL: Record<Deal["urgency"], string> = {
  today: "Сьогодні",
  tomorrow: "Завтра",
  week: "Цього тижня",
  later: "Потім / договірно",
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("uk-UA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <>
      <dt className="font-mono text-micro uppercase tracking-[0.18em] text-muted inline-flex items-center gap-2">
        <span className="text-accent">{icon}</span>
        {label}
      </dt>
      <dd className="text-body text-ink-soft break-words">{value}</dd>
    </>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted">{label}</span>
      <span className="font-mono tabular-nums text-ink">{children}</span>
    </div>
  );
}

function PartyCard({
  party,
  roleLabel,
  isYou,
}: {
  party: Deal["client"] | Deal["provider"];
  roleLabel: string;
  isYou: boolean;
}) {
  return (
    <div className="border border-hairline rounded-[var(--radius-sm)] bg-canvas p-4">
      <div className="flex items-center gap-3">
        <Avatar src={party.avatar_url} alt={party.display_name} size="md" />
        <div className="min-w-0">
          <p className="font-display text-body-lg text-ink leading-tight truncate">
            {party.display_name}
          </p>
          <p className="font-mono text-micro uppercase tracking-[0.18em] text-muted mt-0.5">
            {roleLabel}
            {isYou && " · ви"}
          </p>
        </div>
        {party.kyc_verified && (
          <Badge tone="success" size="sm" shape="square" className="ml-auto">
            <ShieldCheck size={10} className="mr-0.5" />
            KYC
          </Badge>
        )}
      </div>
    </div>
  );
}
