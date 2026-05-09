"use client";
import { useState } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { MobileTabBar } from "@/components/organisms/MobileTabBar";
import { Footer } from "@/components/organisms/Footer";
import { DealStateTracker, type DealStatus } from "@/components/organisms/DealStateTracker";
import { DealHeader } from "@/components/organisms/DealHeader";
import { DealTimeline, type DealEvent } from "@/components/organisms/DealTimeline";
import { EscrowStatusCard, type EscrowStatus } from "@/components/organisms/EscrowStatusCard";
import { DealActionsPanel } from "@/components/organisms/DealActionsPanel";
import { DisputeBanner } from "@/components/organisms/DisputeBanner";
import { Tag } from "@/components/ui/Tag";
import { Button } from "@/components/ui/Button";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

const STATES: DealStatus[] = ["pending", "active", "in_review", "completed", "disputed", "cancelled"];

const ESCROW_BY_STATUS: Record<DealStatus, EscrowStatus> = {
  pending: "hold_requested",
  active: "held",
  in_review: "held",
  completed: "released",
  disputed: "held",
  cancelled: "refunded",
};

const EVENTS: Record<DealStatus, DealEvent[]> = {
  pending: [
    {
      id: 1,
      label: "Запит надіслано провайдеру",
      tone: "info",
      at: "2026-05-09T10:14:00Z",
      actor: { name: "Сергій П.", role: "client" },
      description: "Очікуємо підтвердження протягом 72 годин",
    },
  ],
  active: [
    { id: 2, label: "Ескроу заблоковано", tone: "info", at: "2026-05-09T11:02:00Z", actor: { name: "LiqPay", role: "system" }, details: [{ label: "Hold ID", value: "ph_9af3-4521" }, { label: "Сума", value: "12 000,00 ₴" }] },
    { id: 1, label: "Провайдер прийняв угоду", tone: "success", at: "2026-05-09T10:58:00Z", actor: { name: "Bosch Group", role: "provider" } },
    { id: 0, label: "Запит надіслано", tone: "neutral", at: "2026-05-09T10:14:00Z", actor: { name: "Сергій П.", role: "client" } },
  ],
  in_review: [
    { id: 3, label: "Провайдер здав роботу", tone: "info", at: "2026-05-12T16:30:00Z", actor: { name: "Bosch Group", role: "provider" }, description: "Завантажено 4 фото, опис проведених робіт" },
    { id: 2, label: "Ескроу заблоковано", tone: "neutral", at: "2026-05-09T11:02:00Z", actor: { name: "LiqPay", role: "system" } },
    { id: 1, label: "Провайдер прийняв угоду", tone: "neutral", at: "2026-05-09T10:58:00Z", actor: { name: "Bosch Group", role: "provider" } },
  ],
  completed: [
    { id: 5, label: "Кошти виплачено провайдеру", tone: "success", at: "2026-05-13T09:01:00Z", actor: { name: "LiqPay", role: "system" }, details: [{ label: "Сума", value: "12 000,00 ₴" }, { label: "Комісія", value: "120,00 ₴" }] },
    { id: 4, label: "Клієнт прийняв роботу", tone: "success", at: "2026-05-12T18:40:00Z", actor: { name: "Сергій П.", role: "client" } },
    { id: 3, label: "Робота здана", tone: "neutral", at: "2026-05-12T16:30:00Z", actor: { name: "Bosch Group", role: "provider" } },
  ],
  disputed: [
    { id: 4, label: "Спір відкрито клієнтом", tone: "warning", at: "2026-05-12T19:00:00Z", actor: { name: "Сергій П.", role: "client" }, description: "Причина: робота виконана не повністю", details: [{ label: "Доказів", value: "3 фото + 1 PDF" }] },
    { id: 3, label: "Робота здана", tone: "neutral", at: "2026-05-12T16:30:00Z", actor: { name: "Bosch Group", role: "provider" } },
  ],
  cancelled: [
    { id: 2, label: "Угоду скасовано", tone: "danger", at: "2026-05-09T13:00:00Z", actor: { name: "Сергій П.", role: "client" }, description: "Причина: знайшов іншого виконавця" },
    { id: 1, label: "Запит надіслано", tone: "neutral", at: "2026-05-09T10:14:00Z", actor: { name: "Сергій П.", role: "client" } },
  ],
};

const DEAL = {
  id: "9af3-4521",
  title: "Ремонт пральної машини Bosch WAS28443 — діагностика і заміна тенів",
  category: "Ремонт побутової техніки",
  agreedPriceKopecks: 1200000,
  createdAt: "2026-05-09T10:14:00Z",
  deadlineAt: "2026-05-15T18:00:00Z",
  client: {
    id: "c1",
    displayName: "Сергій Пономаренко",
    avatarUrl: "https://i.pravatar.cc/120?img=33",
    kycVerified: true,
    role: "client" as const,
  },
  provider: {
    id: "p1",
    displayName: "Bosch Group Service",
    avatarUrl: "https://i.pravatar.cc/120?img=12",
    kycVerified: true,
    role: "provider" as const,
  },
  listing: {
    id: "lst-9241",
    title: "Ремонт пральних машин Bosch / Siemens",
    href: "#",
  },
};

export default function DealDemoPage() {
  const [status, setStatus] = useState<DealStatus>("in_review");
  const [role, setRole] = useState<"client" | "provider" | "admin">("client");

  return (
    <>
      <TopNav user={USER} notificationsUnread={2} messagesUnread={3} />
      <main className="mx-auto max-w-6xl px-4 md:px-6 py-6 md:py-10 pb-24 md:pb-16">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "Угоди", href: "/deals" },
            { label: `DLR-${DEAL.id}` },
          ]}
        />

        {/* Demo controls */}
        <div className="mb-8 flex flex-wrap items-center gap-3 p-3 rounded-[var(--radius-md)] border border-dashed border-hairline-strong bg-elevated/40">
          <span className="font-mono text-micro uppercase tracking-loose text-muted-soft">
            demo · стани
          </span>
          {STATES.map((s) => (
            <Tag key={s} interactive selected={status === s} onClick={() => setStatus(s)}>
              {s}
            </Tag>
          ))}
          <span className="ml-auto inline-flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-loose text-muted-soft">роль</span>
            {(["client", "provider", "admin"] as const).map((r) => (
              <Tag key={r} interactive selected={role === r} onClick={() => setRole(r)}>
                {r}
              </Tag>
            ))}
          </span>
        </div>

        <DealHeader data={{ ...DEAL, status }} viewerRole={role === "admin" ? undefined : role} />

        {status === "disputed" && (
          <div className="mb-8">
            <DisputeBanner
              mode={
                role === "provider"
                  ? "provider_must_respond"
                  : role === "admin"
                    ? "admin_review"
                    : "client_waiting_response"
              }
              daysRemaining={2}
              hoursRemaining={6}
              primaryAction={role === "provider" ? <Button>Подати відповідь</Button> : undefined}
            />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
          <div className="min-w-0 space-y-8">
            <section>
              <h2 className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-4">
                Етапи угоди
              </h2>
              <DealStateTracker
                status={status}
                countdown={
                  status === "in_review"
                    ? { label: "авто-завершення через", expiresAt: "5 дн 14 год" }
                    : status === "pending"
                      ? { label: "запит спливає через", expiresAt: "2 дн 12 год" }
                      : undefined
                }
              />
            </section>

            <section>
              <h2 className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-4">
                Хронологія
              </h2>
              <DealTimeline events={EVENTS[status]} />
            </section>
          </div>

          <aside className="space-y-4">
            <EscrowStatusCard
              status={ESCROW_BY_STATUS[status]}
              amountKopecks={DEAL.agreedPriceKopecks}
              heldAt={status === "active" || status === "in_review" || status === "disputed" || status === "completed" ? "2026-05-09T11:02:00Z" : undefined}
              holdExpiresAt={status === "active" ? "2026-05-15T18:00:00Z" : undefined}
            />
            <DealActionsPanel
              status={status}
              role={role}
              onAction={(id) => console.log("action", id)}
              onMessage={() => {}}
            />
          </aside>
        </div>

        {/* Vertical tracker for mobile */}
        <section className="mt-12">
          <h2 className="font-mono text-micro uppercase tracking-loose text-muted-soft mb-4">
            Vertical variant (mobile sidebar)
          </h2>
          <div className="max-w-xs border border-hairline rounded-[var(--radius-md)] bg-paper p-5">
            <DealStateTracker status={status} variant="vertical" />
          </div>
        </section>
      </main>
      <Footer />
      <MobileTabBar messagesUnread={3} />
    </>
  );
}
