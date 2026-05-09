"use client";
import { useState, useMemo } from "react";
import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import {
  ConversationList,
  type ConversationItem,
} from "@/components/organisms/ConversationList";
import {
  MessageBubble,
  type MessageBubbleData,
} from "@/components/organisms/MessageBubble";
import {
  Composer,
  type ComposerAttachment,
} from "@/components/organisms/Composer";
import { ContactInfoBlockBanner } from "@/components/organisms/ContactInfoBlockBanner";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ArrowLeft, Phone, MoreHorizontal } from "lucide-react";

const USER = {
  id: "u1",
  displayName: "Сергій П.",
  email: "aks74ym@gmail.com",
  kycVerified: true,
  hasProviderRole: true,
};

const CONVERSATIONS: ConversationItem[] = [
  {
    id: "c1",
    href: "#",
    counterparty: { displayName: "Bosch Group Service", avatarUrl: "https://i.pravatar.cc/120?img=12", kycVerified: true },
    scope: "deal",
    context: { label: "DLR-9af3" },
    lastMessage: { body: "Вже виїхав, буду через 20 хвилин.", senderIsMe: false },
    lastMessageAt: "2026-05-09T11:42:00Z",
    unreadCount: 2,
  },
  {
    id: "c2",
    href: "#",
    counterparty: { displayName: "Микола Петренко", avatarUrl: "https://i.pravatar.cc/120?img=8" },
    scope: "pre_deal",
    context: { label: "Заміна проводки в 2-кімн" },
    lastMessage: { body: "Вартість — від 800 ₴ за точку. Скільки точок?", senderIsMe: false },
    lastMessageAt: "2026-05-09T10:14:00Z",
  },
  {
    id: "c3",
    href: "#",
    counterparty: { displayName: "Wood Atelier", avatarUrl: "https://i.pravatar.cc/120?img=44", kycVerified: true },
    scope: "pre_deal",
    context: { label: "Меблі під замовлення" },
    lastMessage: { body: "Дякую, надішлю креслення завтра.", senderIsMe: true },
    lastMessageAt: "2026-05-08T18:00:00Z",
  },
  {
    id: "c4",
    href: "#",
    counterparty: { displayName: "FixIt", avatarUrl: "https://i.pravatar.cc/120?img=33", kycVerified: true },
    scope: "deal",
    context: { label: "DLR-7831" },
    lastMessage: { body: null, gdprErased: true, senderIsMe: false },
    lastMessageAt: "2026-05-07T15:32:00Z",
    blocked: true,
  },
  {
    id: "c5",
    href: "#",
    counterparty: { displayName: "CleanWave" },
    scope: "pre_deal",
    context: { label: "Прибирання після ремонту" },
    lastMessage: { body: "[контактні дані приховано]", redacted: true, senderIsMe: true },
    lastMessageAt: "2026-05-06T12:10:00Z",
  },
];

const INITIAL_MESSAGES: MessageBubbleData[] = [
  {
    id: "m1",
    senderIsMe: false,
    senderName: "Bosch Group",
    senderAvatarUrl: "https://i.pravatar.cc/120?img=12",
    body: "Вітаю! Бачу ваш запит на ремонт пральної машини WAS28443. Що саме сталось?",
    createdAt: "2026-05-09T10:14:00Z",
  },
  {
    id: "m2",
    senderIsMe: true,
    body: "Доброго дня! Не вмикається повністю, тільки індикатори блимають. Підозрюю, плата управління.",
    createdAt: "2026-05-09T10:16:00Z",
    delivery: "read",
  },
  {
    id: "m3",
    senderIsMe: true,
    body: "Можу скинути фото табло.",
    createdAt: "2026-05-09T10:16:30Z",
    delivery: "read",
  },
  {
    id: "m4",
    senderIsMe: false,
    senderName: "Bosch Group",
    body: "Так, надішліть, будь ласка, фото табло і даних з сервісної таблиці (зазвичай збоку дверцят).",
    createdAt: "2026-05-09T10:18:00Z",
  },
  {
    id: "m5",
    senderIsMe: true,
    body: "Ось.",
    createdAt: "2026-05-09T10:25:00Z",
    delivery: "read",
    attachments: [
      { id: "a1", name: "panel.jpg", thumbUrl: "https://picsum.photos/seed/panel/240/180" },
      { id: "a2", name: "label.jpg", thumbUrl: "https://picsum.photos/seed/label/240/180" },
    ],
  },
  {
    id: "m6",
    senderIsMe: false,
    senderName: "Bosch Group",
    body: null,
    createdAt: "2026-05-09T10:30:00Z",
    autoRedacted: true,
  },
  {
    id: "m7",
    senderIsMe: false,
    senderName: "Bosch Group",
    body: "Виходить, плата управління. У мене є на складі — заміню сьогодні. 1200 ₴ робота + плата 2400 ₴.",
    createdAt: "2026-05-09T10:34:00Z",
  },
  {
    id: "m8",
    senderIsMe: true,
    body: "Окей, давайте оформимо угоду.",
    createdAt: "2026-05-09T10:36:00Z",
    delivery: "read",
  },
  {
    id: "m9",
    senderIsMe: false,
    senderName: "Bosch Group",
    body: "Створив. Підтвердіть оплату — і виїжджаю.",
    createdAt: "2026-05-09T11:01:00Z",
    adminVisible: true,
  },
  {
    id: "m10",
    senderIsMe: false,
    senderName: "Bosch Group",
    body: "Вже виїхав, буду через 20 хвилин.",
    createdAt: "2026-05-09T11:42:00Z",
  },
];

const CONTACT_INFO_REGEX = /(\+?\d{6,}|\b\d{3}[-\s]?\d{2}[-\s]?\d{2}\b|@\w{3,}|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)/i;

export default function MessagesDemoPage() {
  const [activeId, setActiveId] = useState("c1");
  const [scopeFilter, setScopeFilter] = useState<"all" | "pre_deal" | "deal">("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [viewerIsAdmin, setViewerIsAdmin] = useState(false);
  const [bannerMode, setBannerMode] = useState<"none" | "warning" | "blocked_pending_admin" | "blocked">("none");

  const conv = CONVERSATIONS.find((c) => c.id === activeId);
  const contactInfoDetected = useMemo(() => CONTACT_INFO_REGEX.test(draft), [draft]);

  const filteredConvs = search.trim()
    ? CONVERSATIONS.filter((c) =>
        c.counterparty.displayName.toLowerCase().includes(search.toLowerCase())
      )
    : CONVERSATIONS;

  function onSend() {
    if (!draft.trim() && attachments.length === 0) return;
    setMessages((m) => [
      ...m,
      {
        id: `n-${Date.now()}`,
        senderIsMe: true,
        body: draft.trim(),
        createdAt: new Date().toISOString(),
        delivery: "sending",
      },
    ]);
    setDraft("");
    // simulate ack after 600ms
    setTimeout(() => {
      setMessages((m) =>
        m.map((x) => (x.delivery === "sending" ? { ...x, delivery: "delivered" } : x))
      );
    }, 600);
  }

  return (
    <>
      <TopNav user={USER} notificationsUnread={3} messagesUnread={5} />
      <main className="mx-auto max-w-7xl px-0 md:px-6 pt-0 md:pt-6 h-[calc(100vh-4rem)] md:h-[calc(100vh-8rem)] pb-0">
        <div className="grid grid-cols-1 md:grid-cols-[340px_1fr] h-full md:rounded-[var(--radius-md)] md:border md:border-hairline overflow-hidden bg-paper">
          <ConversationList
            items={filteredConvs}
            activeId={activeId}
            scopeFilter={scopeFilter}
            onScopeFilterChange={setScopeFilter}
            searchValue={search}
            onSearchChange={setSearch}
            className="hidden md:flex"
          />

          <section className="flex flex-col h-full min-h-0">
            {/* Conversation header */}
            {conv && (
              <header className="flex items-center gap-3 p-4 border-b border-hairline">
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Назад">
                  <ArrowLeft size={18} />
                </Button>
                <Avatar
                  shape="circle"
                  size="md"
                  alt={conv.counterparty.displayName}
                  src={conv.counterparty.avatarUrl}
                  kycVerified={conv.counterparty.kycVerified}
                />
                <div className="flex-1 min-w-0">
                  <h2 className="font-display text-h3 text-ink tracking-tight truncate leading-none">
                    {conv.counterparty.displayName}
                  </h2>
                  <p className="text-caption text-muted truncate">
                    {conv.scope === "deal" ? "угода " : "лістинг "}
                    <span className="font-mono text-muted-soft">· {conv.context?.label}</span>
                  </p>
                </div>
                <Badge tone={conv.scope === "deal" ? "info" : "neutral"} size="sm">
                  {conv.scope === "deal" ? "deal" : "pre-deal"}
                </Badge>
                <Button variant="ghost" size="icon" aria-label="Дзвінок">
                  <Phone size={16} />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Більше">
                  <MoreHorizontal size={16} />
                </Button>
              </header>
            )}

            {/* Demo: viewer/banner toggles */}
            <div className="px-4 py-2 bg-elevated border-b border-hairline flex flex-wrap items-center gap-2">
              <span className="font-mono text-micro uppercase tracking-loose text-muted-soft">demo</span>
              <Button
                size="sm"
                variant={viewerIsAdmin ? "primary" : "ghost"}
                onClick={() => setViewerIsAdmin((v) => !v)}
              >
                viewer: {viewerIsAdmin ? "admin" : "party"}
              </Button>
              {(["none", "warning", "blocked_pending_admin", "blocked"] as const).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={bannerMode === m ? "primary" : "ghost"}
                  onClick={() => setBannerMode(m)}
                >
                  {m}
                </Button>
              ))}
            </div>

            {/* Messages list */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-canvas/40 flex flex-col gap-2.5">
              {bannerMode !== "none" && (
                <div className="mb-2">
                  <ContactInfoBlockBanner
                    mode={bannerMode}
                    remaining={2}
                    onAppeal={() => {}}
                  />
                </div>
              )}
              {messages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  data={{ ...m, viewerIsAdmin }}
                  groupedWithPrev={
                    i > 0 && messages[i - 1].senderIsMe === m.senderIsMe
                  }
                />
              ))}
            </div>

            {/* Composer */}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={onSend}
              attachments={attachments}
              onAttachmentsAdd={(files) =>
                setAttachments((cur) => [
                  ...cur,
                  ...files.map((f) => ({
                    id: crypto.randomUUID(),
                    fileName: f.name,
                    sizeBytes: f.size,
                    mimeType: f.type,
                    status: "ready" as const,
                  })),
                ])
              }
              onAttachmentRemove={(id) =>
                setAttachments((cur) => cur.filter((a) => a.id !== id))
              }
              contactInfoDetected={contactInfoDetected}
              blocked={bannerMode === "blocked"}
            />
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
