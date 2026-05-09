"use client";
import { useState } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import { NotificationsInbox } from "@/components/organisms/NotificationsInbox";
import type { NotificationItemData } from "@/components/organisms/NotificationItem";
import {
  AdminQueueRow,
  type AdminQueueItem,
} from "@/components/organisms/AdminQueueRow";
import {
  AdminAuditEntry,
  type AdminAuditEntryData,
} from "@/components/organisms/AdminAuditEntry";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Badge } from "@/components/ui/Badge";
import { SortDropdown, type SortKey } from "@/components/organisms/SortDropdown";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  hasProviderRole: true,
};

const NOTIFICATIONS: NotificationItemData[] = [
  {
    id: "n1",
    code: "deal_disputed_as_provider",
    aggregateType: "deal",
    title: "Клієнт відкрив спір по угоді DLR-9af3",
    body: "Сергій Пономаренко не задоволений якістю роботи. Маєте 3 дні, щоб подати відповідь і докази.",
    createdAt: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    href: "#",
    mandatory: true,
  },
  {
    id: "n2",
    code: "review_published_for_you",
    aggregateType: "review",
    title: "Олена К. залишила 5★ відгук",
    body: "«Майстер приїхав вчасно, швидко діагностував проблему — перегоріла плата управління…»",
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    href: "#",
  },
  {
    id: "n3",
    code: "payout_completed_for_provider",
    aggregateType: "payout",
    title: "Виплата 3 250,00 ₴ зарахована",
    body: "DLR-7820 · LiqPay · ...4521",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    href: "#",
    read: true,
  },
  {
    id: "n4",
    code: "new_message_for_recipient",
    aggregateType: "message",
    title: "Нове повідомлення від Микола Петренко",
    body: "Вартість — від 800 ₴ за точку. Скільки точок?",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 23).toISOString(),
    href: "#",
  },
  {
    id: "n5",
    code: "kyc_expired_for_provider",
    aggregateType: "user",
    title: "Ваш KYC спливає за 14 днів",
    body: "Поновіть документи, щоб виплати не призупинились.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    href: "#",
    mandatory: true,
    read: true,
  },
  {
    id: "n6",
    code: "chargeback_received_for_provider",
    aggregateType: "chargeback",
    title: "Чарджбек по DLR-7755 — 2 800,00 ₴",
    body: "Клієнт оспорив транзакцію. Подайте докази до 2026-05-15.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
    href: "#",
    mandatory: true,
  },
];

const QUEUE: AdminQueueItem[] = [
  {
    id: "q1",
    source: "dispute",
    severity: "P0",
    title: "Спір по DLR-9af3 · сума 12 000 ₴",
    summary: "Клієнт скаржиться на якість ремонту. Provider response — submitted.",
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    dueAt: new Date(Date.now() + 1000 * 60 * 60 * 3).toISOString(),
    href: "#",
    tags: ["Київ", "повторний"],
  },
  {
    id: "q2",
    source: "kyc",
    severity: "P1",
    title: "KYC submitted · u_5821",
    summary: "Документи: passport_uk · liveness ok",
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    dueAt: new Date(Date.now() + 1000 * 60 * 60 * 18).toISOString(),
    href: "#",
    claimedBy: { name: "moderator_a" },
  },
  {
    id: "q3",
    source: "chargeback",
    severity: "P0",
    title: "Чарджбек · DLR-7755 · 2 800 ₴",
    summary: "PSP webhook · reason_code 4855 · потрібен evidence-pack",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
    dueAt: new Date(Date.now() + 1000 * 60 * 60 * 36).toISOString(),
    href: "#",
  },
  {
    id: "q4",
    source: "report",
    severity: "P2",
    title: "Скарга на відгук · r_2104",
    summary: "Підозра на образу. Reporter: u_88",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
    href: "#",
    tags: ["перший"],
  },
  {
    id: "q5",
    source: "listing",
    severity: "P3",
    title: "Лістинг подано на модерацію · LST-9241",
    summary: "Категорія Електрика → Заміна проводки",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
    href: "#",
    claimedBy: { name: "moderator_b" },
  },
];

const AUDIT: AdminAuditEntryData[] = [
  {
    id: "a1",
    at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    actor: { id: "admin_1", name: "Anya · admin", avatarUrl: "https://i.pravatar.cc/120?img=29" },
    action: "dispute.resolve",
    target: { type: "deal", id: "DLR-9af3" },
    metadata: {
      outcome: "split",
      release_amount: 850000,
      refund_amount: 350000,
      reason: "partial_quality",
    },
    approvedBy: { id: "admin_2", name: "Roman · senior_admin" },
    requestId: "req_2026_05_09_a91b",
  },
  {
    id: "a2",
    at: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
    actor: { id: "moderator_a", name: "Roman · moderator" },
    action: "kyc.approve",
    target: { type: "user", id: "u_5818" },
    metadata: { document_kind: "passport_uk", expires_at: "2027-04-12" },
    requestId: "req_2026_05_09_4f12",
  },
  {
    id: "a3",
    at: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    actor: { id: "moderator_b", name: "Yulia · moderator" },
    action: "review.takedown",
    target: { type: "review", id: "r_2098" },
    metadata: { reason: "abuse", reviewer: "u_771" },
    requestId: "req_2026_05_09_1e88",
  },
  {
    id: "a4",
    at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    actor: { id: "support_1", name: "Olha · support" },
    action: "view_dispute_messages",
    target: { type: "deal", id: "DLR-9af3" },
    metadata: { message_count: 12, cursor_after: null },
    requestId: "req_2026_05_09_2c41",
  },
  {
    id: "a5",
    at: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    actor: { id: "admin_1", name: "Anya · admin" },
    action: "bulk.execute",
    target: { type: "listing", id: "bulk_88" },
    metadata: { count: 7, action: "takedown", reason: "spam" },
    approvedBy: { id: "admin_2", name: "Roman · senior_admin" },
    requestId: "req_2026_05_09_b302",
  },
];

export default function AdminDemoPage() {
  const [items, setItems] = useState(NOTIFICATIONS);
  const [sort, setSort] = useState<SortKey>("newest");

  return (
    <>
      <TopNav user={{ ...USER, displayName: "Anya · admin" }} role="provider" />
      <main className="mx-auto max-w-6xl px-4 md:px-6 py-10 pb-24 md:pb-16 space-y-12">
        <header>
          <div className="flex items-center gap-3 mb-3">
            <Badge tone="ink" shape="square" size="sm">admin</Badge>
            <span className="font-mono text-caption text-muted">
              Module 9 + 12 organisms
            </span>
          </div>
          <h1 className="font-display text-h1 md:text-display text-ink tracking-tight leading-[1.05]">
            Inbox · черга · аудит
          </h1>
        </header>

        <Tabs defaultValue="inbox">
          <TabsList>
            <TabsTrigger value="inbox" count={items.filter((i) => !i.read).length}>
              Sender inbox
            </TabsTrigger>
            <TabsTrigger value="queue" count={QUEUE.filter((q) => !q.claimedBy).length}>
              Admin queue
            </TabsTrigger>
            <TabsTrigger value="audit">Audit log</TabsTrigger>
          </TabsList>

          <TabsContent value="inbox">
            <NotificationsInbox
              items={items}
              onMarkRead={(id) =>
                setItems((cur) => cur.map((x) => (x.id === id ? { ...x, read: true } : x)))
              }
              onMarkAllRead={() =>
                setItems((cur) => cur.map((x) => ({ ...x, read: true })))
              }
              onDismiss={(id) => setItems((cur) => cur.filter((x) => x.id !== id))}
            />
          </TabsContent>

          <TabsContent value="queue">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
              <header className="px-4 py-4 border-b border-hairline flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-h3 text-ink tracking-tight leading-none">
                    Уніфікована черга
                  </h2>
                  <p className="text-caption text-muted-soft mt-0.5 font-mono">
                    {QUEUE.length} активних · {QUEUE.filter((q) => q.claimedBy).length} взято
                  </p>
                </div>
                <SortDropdown value={sort} onChange={setSort} size="sm" />
              </header>
              <div>
                {QUEUE.map((q) => (
                  <AdminQueueRow
                    key={q.id}
                    item={q}
                    selfId="Anya · admin"
                    onClaim={() => {}}
                  />
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="audit">
            <div className="border border-hairline rounded-[var(--radius-md)] bg-paper overflow-hidden">
              <header className="px-5 py-4 border-b border-hairline">
                <h2 className="font-display text-h3 text-ink tracking-tight leading-none">
                  admin_actions
                </h2>
                <p className="text-caption text-muted-soft mt-0.5 font-mono">
                  REVOKE-protected append-only log · last {AUDIT.length} entries
                </p>
              </header>
              <div>
                {AUDIT.map((a) => (
                  <AdminAuditEntry key={a.id} data={a} />
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
    </>
  );
}
