"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, MessageCircle } from "lucide-react";

import { TopNav } from "@/components/organisms/TopNav";
import { Footer } from "@/components/organisms/Footer";
import {
  ConversationList,
  type ConversationItem,
} from "@/components/organisms/ConversationList";
import { MessageBubble } from "@/components/organisms/MessageBubble";
import { Composer } from "@/components/organisms/Composer";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useRequireAuth } from "@/lib/auth";
import {
  useConversations,
  useConversationMessages,
  sendMessage,
  markConversationRead,
} from "@/lib/messaging";

export default function MessagesPage() {
  const auth = useRequireAuth("/login");
  const searchParams = useSearchParams();
  const initialId = searchParams.get("c");
  const conversations = useConversations();

  const [activeId, setActiveId] = React.useState<string | null>(initialId);
  const [scopeFilter, setScopeFilter] = React.useState<
    "all" | "pre_deal" | "deal"
  >("all");
  const [search, setSearch] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  // Auto-select first conversation once data arrives.
  React.useEffect(() => {
    if (activeId) return;
    if (conversations.items && conversations.items.length > 0) {
      setActiveId(conversations.items[0].id);
    }
  }, [activeId, conversations.items]);

  // Mark active conversation read whenever we open it.
  React.useEffect(() => {
    if (!activeId) return;
    void markConversationRead(activeId);
  }, [activeId]);

  const msgs = useConversationMessages(activeId);
  const activeConvo = React.useMemo(() => {
    if (!activeId || !conversations.items) return null;
    return conversations.items.find((c) => c.id === activeId) ?? null;
  }, [activeId, conversations.items]);

  // Auto-scroll to bottom on new message.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs.items?.length, activeId]);

  if (auth === null) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-canvas">
        <Loader2 size={20} className="animate-spin text-muted" />
      </main>
    );
  }

  const me = auth.user;

  // Map server conversations → ConversationList items, applying local search +
  // scope filter (server already filters out archived; q is a UI-only sieve
  // for v1, before /admin search FTS lands).
  const filtered: ConversationItem[] = React.useMemo(() => {
    if (!conversations.items) return [];
    return conversations.items
      .filter((c) => scopeFilter === "all" || c.scope === scopeFilter)
      .filter((c) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
          (c.counterparty?.display_name ?? "").toLowerCase().includes(q) ||
          (c.last_message_preview ?? "").toLowerCase().includes(q)
        );
      })
      .map<ConversationItem>((c) => ({
        id: c.id,
        href: `/messages?c=${encodeURIComponent(c.id)}`,
        counterparty: {
          displayName: c.counterparty?.display_name ?? "—",
          avatarUrl: c.counterparty?.avatar_url,
          kycVerified: c.counterparty?.kyc_verified,
        },
        scope: c.scope,
        lastMessage: c.last_message_preview
          ? { body: c.last_message_preview }
          : undefined,
        lastMessageAt: c.last_message_at ?? undefined,
        unreadCount: c.unread_count,
        context: c.deal_id
          ? { label: `Угода ${c.deal_id.slice(0, 6)}`, href: `/deals/${c.deal_id}` }
          : c.listing_id
            ? { label: "Послуга", href: `/listings/${c.listing_id}` }
            : undefined,
        blocked: c.status !== "active",
      }));
  }, [conversations.items, scopeFilter, search]);

  const send = async () => {
    if (sending || !activeId) return;
    const body = draft.trim();
    if (body.length === 0) return;
    setSending(true);
    setSendError(null);
    const r = await sendMessage(activeId, body);
    setSending(false);
    if (r.ok) {
      msgs.append(r.message);
      setDraft("");
      conversations.refresh();
    } else {
      setSendError(r.error.message);
    }
  };

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-7xl px-0 md:px-6 md:py-8">
        <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-0 md:gap-6 border border-hairline rounded-none md:rounded-[var(--radius-md)] bg-paper overflow-hidden min-h-[80vh]">
          {/* LEFT — conversation list */}
          <aside className="border-b md:border-b-0 md:border-r border-hairline min-w-0">
            <ConversationList
              items={filtered}
              activeId={activeId ?? undefined}
              scopeFilter={scopeFilter}
              onScopeFilterChange={setScopeFilter}
              searchValue={search}
              onSearchChange={setSearch}
            />
          </aside>

          {/* RIGHT — active conversation */}
          <section className="flex flex-col min-w-0 min-h-[60vh] md:min-h-0">
            {!activeConvo ? (
              <EmptyState
                loading={conversations.items === null}
                empty={
                  conversations.items?.length === 0 &&
                  conversations.error === null
                }
              />
            ) : (
              <>
                {/* Header */}
                <header className="flex items-center gap-3 px-5 py-4 border-b border-hairline">
                  <Avatar
                    src={activeConvo.counterparty?.avatar_url}
                    alt={activeConvo.counterparty?.display_name ?? ""}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-body text-ink truncate">
                        {activeConvo.counterparty?.display_name ?? "—"}
                      </span>
                      {activeConvo.counterparty?.kyc_verified && (
                        <Badge tone="success" size="sm" shape="square">
                          KYC
                        </Badge>
                      )}
                      {activeConvo.status === "locked" && (
                        <Badge tone="neutral" size="sm" shape="square">
                          Закрито
                        </Badge>
                      )}
                    </div>
                    <div className="text-caption text-muted truncate">
                      {activeConvo.scope === "deal"
                        ? "Чат за угодою"
                        : "Перед-угода"}
                    </div>
                  </div>
                </header>

                {/* Messages */}
                <div
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto px-5 py-6 space-y-2 bg-canvas"
                >
                  {msgs.items === null ? (
                    <div className="flex justify-center py-16">
                      <Loader2 size={18} className="animate-spin text-muted" />
                    </div>
                  ) : msgs.items.length === 0 ? (
                    <div className="text-center py-16 text-caption text-muted">
                      Поки немає повідомлень. Напишіть першим.
                    </div>
                  ) : (
                    msgs.items.map((m, idx) => {
                      const prev = idx > 0 ? msgs.items![idx - 1] : null;
                      const grouped =
                        prev?.sender_id === m.sender_id &&
                        new Date(m.created_at).getTime() -
                          new Date(prev.created_at).getTime() <
                          5 * 60 * 1000;
                      return (
                        <MessageBubble
                          key={m.id}
                          groupedWithPrev={grouped}
                          data={{
                            id: m.id,
                            body: m.body,
                            createdAt: m.created_at,
                            senderIsMe: m.sender_id === me.id,
                            senderName:
                              m.sender_id === me.id
                                ? me.display_name
                                : activeConvo.counterparty?.display_name,
                            senderAvatarUrl:
                              m.sender_id === me.id
                                ? me.avatar_url
                                : activeConvo.counterparty?.avatar_url,
                            delivery: "sent",
                            gdprErased: !!m.gdpr_erased_at,
                            autoRedacted: m.body_scrubbed,
                            adminVisible: m.admin_visible,
                          }}
                        />
                      );
                    })
                  )}
                </div>

                {/* Composer */}
                <div className="border-t border-hairline">
                  {sendError && (
                    <div className="px-5 pt-3">
                      <InlineAlert tone="danger">{sendError}</InlineAlert>
                    </div>
                  )}
                  <Composer
                    value={draft}
                    onChange={setDraft}
                    onSend={send}
                    loading={sending}
                    blocked={activeConvo.status !== "active"}
                    maxLength={4000}
                  />
                </div>
              </>
            )}
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}

function EmptyState({ loading, empty }: { loading: boolean; empty: boolean }) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted" />
      </div>
    );
  }
  if (empty) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <MessageCircle size={28} className="text-muted" aria-hidden />
        <div className="text-body text-ink">Повідомлень ще немає</div>
        <p className="text-caption text-muted max-w-sm">
          Бесіди створюються автоматично, коли ви пишете виконавцю з картки
          послуги або відкриваєте угоду.
        </p>
      </div>
    );
  }
  return (
    <div className="flex-1 flex items-center justify-center text-caption text-muted">
      Оберіть бесіду зліва
    </div>
  );
}
