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
  cancelRequest,
  type Deal,
  type DealAction,
} from "@/lib/deals";
import { AlertTriangle } from "lucide-react";

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
  const [cancelReqOpen, setCancelReqOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");

  // ---- mutual cancel derived state ----
  const myCancelTs =
    role === "client"
      ? current.cancel_requested_by_client_at
      : role === "provider"
        ? current.cancel_requested_by_provider_at
        : null;
  const counterCancelTs =
    role === "client"
      ? current.cancel_requested_by_provider_at
      : role === "provider"
        ? current.cancel_requested_by_client_at
        : null;
  const counterCancelLabel = role === "client" ? "Виконавець" : "Клієнт";

  // Keep local state in sync if parent refetches
  React.useEffect(() => setCurrent(deal), [deal]);

  // ---- transition handlers ----
  const WIRED_ACTIONS: ReadonlyArray<DealAction> = [
    "accept",
    "reject",
    "cancel",
    "submit",
    "approve",
    "dispute",
  ];
  const onAction = (id: string) => {
    setActionError(null);
    if (id === "cancel-request") {
      setCancelReason("");
      setCancelReqOpen(true);
      return;
    }
    if ((WIRED_ACTIONS as ReadonlyArray<string>).includes(id)) {
      setPendingAction(id as DealAction);
    } else {
      // dispute-grace / respond / evidence / resolve / ask-evidence /
      // escalate / thank / review — depend on Modules 11/12/14 and out
      // of MVP scope here.
      setActionError(
        "Ця дія ще не пов'язана з бекендом — буде додано наступним кроком."
      );
    }
  };
  const submitCancelRequest = async () => {
    if (busy) return;
    setBusy(true);
    const result = await cancelRequest(current.id, "request", cancelReason);
    setBusy(false);
    if (result.ok) {
      setCurrent(result.deal);
      setCancelReqOpen(false);
    } else {
      setActionError(result.error.message);
      setCancelReqOpen(false);
    }
  };
  const revokeCancelRequest = async () => {
    if (busy) return;
    setBusy(true);
    const result = await cancelRequest(current.id, "revoke");
    setBusy(false);
    if (result.ok) {
      setCurrent(result.deal);
    } else {
      setActionError(result.error.message);
    }
  };
  const agreeToCancel = async () => {
    if (busy) return;
    setBusy(true);
    const result = await cancelRequest(current.id, "request");
    setBusy(false);
    if (result.ok) {
      setCurrent(result.deal);
    } else {
      setActionError(result.error.message);
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

        {/* Counterparty has requested cancellation — caller can agree */}
        {current.status === "active" && counterCancelTs && !myCancelTs && (
          <div className="mb-6">
            <InlineAlert
              tone="warning"
              title={`${counterCancelLabel} запитує скасування угоди`}
              action={
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy}
                    onClick={agreeToCancel}
                  >
                    Погодитись скасуванням
                  </Button>
                </div>
              }
            >
              {current.cancel_request_reason ? (
                <>
                  Причина: <span className="text-ink">«{current.cancel_request_reason}»</span>.
                  Підтвердіть, щоб припинити угоду; кошти повернуться клієнту.
                  Запит чинний до{" "}
                  {new Date(
                    new Date(counterCancelTs).getTime() +
                      48 * 60 * 60 * 1000
                  ).toLocaleString("uk-UA")}
                  .
                </>
              ) : (
                <>
                  Інша сторона ініціювала припинення без причини. Якщо ви також
                  бажаєте скасувати — підтвердіть; інакше запит діятиме 48 годин.
                </>
              )}
            </InlineAlert>
          </div>
        )}

        {/* Caller has requested cancellation — counterparty hasn't agreed yet */}
        {current.status === "active" && myCancelTs && !counterCancelTs && (
          <div className="mb-6">
            <InlineAlert
              tone="info"
              title="Очікуємо згоди контрагента на скасування"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy}
                  onClick={revokeCancelRequest}
                >
                  Скасувати запит
                </Button>
              }
            >
              Запит діятиме до{" "}
              {new Date(
                new Date(myCancelTs).getTime() + 48 * 60 * 60 * 1000
              ).toLocaleString("uk-UA")}
              . Якщо контрагент не погодиться — угода залишається в роботі.
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

      {/* Cancel-request reason modal */}
      {cancelReqOpen && (
        <Modal
          open={true}
          onOpenChange={(open) => !open && setCancelReqOpen(false)}
          title="Запросити скасування угоди?"
          description="Скасування з активної угоди потребує згоди обох сторін. Якщо ви ініціатор — інша сторона побачить ваш запит."
          size="md"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setCancelReqOpen(false)}
                disabled={busy}
              >
                Назад
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={submitCancelRequest}
              >
                Надіслати запит
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-[var(--radius-sm)] bg-warning-soft/50 border border-warning/30">
              <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
              <p className="text-caption text-ink-soft leading-relaxed">
                Якщо інша сторона погодиться — угода перейде в «скасовано», а
                кошти повернуться клієнту. Якщо ні — запит закінчиться через 48 год.
              </p>
            </div>
            <label className="block">
              <span className="font-mono text-micro uppercase tracking-[0.18em] text-muted">
                Причина (опційно, до 500 символів)
              </span>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                maxLength={500}
                rows={4}
                placeholder="Що сталося? Допоможе іншій стороні швидше зрозуміти контекст."
                className="mt-2 w-full rounded-[var(--radius-sm)] border border-hairline bg-paper px-3 py-2 text-body text-ink leading-relaxed focus:outline-none focus:border-accent placeholder:text-muted-soft resize-none"
              />
            </label>
          </div>
        </Modal>
      )}

      {/* Confirm action modal */}
      {pendingAction && (
        <Modal
          open={true}
          onOpenChange={(open) => !open && setPendingAction(null)}
          title={ACTION_COPY[pendingAction].title}
          description={ACTION_COPY[pendingAction].description}
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
                variant={ACTION_COPY[pendingAction].variant}
                loading={busy}
                onClick={confirmAction}
              >
                {ACTION_COPY[pendingAction].confirmLabel}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-body text-ink-soft leading-relaxed">
            <p>{ACTION_COPY[pendingAction].body}</p>
          </div>
        </Modal>
      )}

      <Footer />
      <MobileTabBar />
    </>
  );
}

/* ---------- helpers ---------- */

const ACTION_COPY: Record<
  DealAction,
  {
    title: string;
    description: string;
    body: string;
    confirmLabel: string;
    variant: "accent" | "danger";
  }
> = {
  accept: {
    title: "Прийняти угоду?",
    description: "Підтверджуючи, ви беретесь виконати роботу за зазначеним брифом.",
    body: "Стан перейде у «у роботі». Клієнт отримає сповіщення.",
    confirmLabel: "Так, прийняти",
    variant: "accent",
  },
  reject: {
    title: "Відхилити угоду?",
    description: "Кошти повернуться клієнту негайно. Ця дія незворотна.",
    body: "Угода перейде у «скасовано». Клієнт отримає сповіщення з можливістю звернутись до іншого виконавця.",
    confirmLabel: "Так, відхилити",
    variant: "danger",
  },
  cancel: {
    title: "Скасувати запит?",
    description: "Кошти повернуться вам. Виконавець більше не побачить запит.",
    body: "Угода перейде у «скасовано». Це можна зробити лише поки виконавець не прийняв.",
    confirmLabel: "Так, скасувати",
    variant: "danger",
  },
  submit: {
    title: "Здати роботу на перевірку?",
    description: "Угода перейде у «перевірка». У клієнта є 7 днів, щоб прийняти або відкрити спір.",
    body: "Перед натисканням переконайтесь, що завантажили підтвердження виконання — клієнт побачить його у чаті.",
    confirmLabel: "Так, здати",
    variant: "accent",
  },
  approve: {
    title: "Прийняти роботу?",
    description: "Кошти переказуються виконавцю. Це остаточна дія.",
    body: "Після підтвердження ви зможете залишити відгук. Якщо є зауваження — спершу обговоріть у чаті або відкрийте спір.",
    confirmLabel: "Так, прийняти",
    variant: "accent",
  },
  dispute: {
    title: "Відкрити спір?",
    description: "Кошти залишаються заблокованими до рішення модератора (до 14 днів).",
    body: "Опишіть проблему та додайте докази (фото, скріни чату). У виконавця буде 3 дні на відповідь.",
    confirmLabel: "Так, відкрити спір",
    variant: "danger",
  },
};

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
