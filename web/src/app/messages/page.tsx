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
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { ContactInfoBlockBanner } from "@/components/organisms/ContactInfoBlockBanner";
import { useRequireAuth } from "@/lib/auth";
import {
  useConversations,
  useConversationMessages,
  sendMessage,
  markConversationRead,
  blockConversationApi,
  unblockConversationApi,
  editMessageApi,
  deleteMessageApi,
} from "@/lib/messaging";
import { useUploader, getMediaStreamUrl } from "@/lib/media";
import type { ComposerAttachment } from "@/components/organisms/Composer";

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
  // Per-message edit state: id of the message currently being edited (only
  // one at a time) + its draft body. Null when nobody is editing.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState("");

  // Attachments uploader scoped to message_attachment purpose. Reset on
  // conversation switch so a half-uploaded file from convo A doesn't show
  // up in convo B.
  const uploader = useUploader({
    purpose: "message_attachment",
    maxFiles: 5,
  });
  React.useEffect(() => {
    uploader.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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

  // Live contact-info warning before send (UX hint; server runs canonical
  // detection on submit and auto-redacts).
  const draftHasContact = React.useMemo(() => {
    const t = draft.trim();
    if (t.length < 5) return false;
    return /\+?\d[\d\s\-()]{8,}\d|[\w.+-]+@[\w.-]+\.[a-z]{2,}|@[a-z0-9_]{4,}|https?:\/\/|www\.|viber|whatsapp|telegram|тел[\.:]/i.test(
      t
    );
  }, [draft]);

  const send = async () => {
    if (sending || !activeId) return;
    const body = draft.trim();
    const attachmentIds = uploader.mediaIds;
    if (body.length === 0 && attachmentIds.length === 0) return;
    if (uploader.uploading || uploader.hasErrors) {
      setSendError(
        uploader.hasErrors
          ? "Видаліть файли з помилкою"
          : "Зачекайте завершення завантаження"
      );
      return;
    }
    setSending(true);
    setSendError(null);
    const r = await sendMessage(activeId, body, attachmentIds);
    setSending(false);
    if (r.ok) {
      msgs.append(r.message);
      setDraft("");
      uploader.reset();
      conversations.refresh();
    } else {
      setSendError(r.error.message);
    }
  };

  const composerAttachments: ComposerAttachment[] = uploader.files.map((f) => ({
    id: f.id,
    fileName: f.file.name,
    sizeBytes: f.file.size,
    mimeType: f.file.type,
    status: f.status,
  }));

  const submitEdit = async (messageId: string) => {
    if (!activeId || !editDraft.trim()) return;
    setSendError(null);
    const r = await editMessageApi(activeId, messageId, editDraft.trim());
    if (r.ok) {
      setEditingId(null);
      setEditDraft("");
      msgs.refresh();
    } else {
      setSendError(r.error.message);
    }
  };

  const doDelete = async (messageId: string) => {
    if (!activeId) return;
    setSendError(null);
    const r = await deleteMessageApi(activeId, messageId);
    if (r.ok) {
      msgs.refresh();
    } else {
      setSendError(r.error.message);
    }
  };

  const toggleBlock = async () => {
    if (!activeConvo) return;
    setSendError(null);
    try {
      if (activeConvo.blocked_by) {
        await unblockConversationApi(activeConvo.id);
      } else {
        await blockConversationApi(activeConvo.id);
      }
      conversations.refresh();
    } catch {
      setSendError("Не вдалось виконати дію — спробуйте ще раз");
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
                      {activeConvo.blocked_by && (
                        <Badge tone="danger" size="sm" shape="square">
                          Заблоковано
                        </Badge>
                      )}
                    </div>
                    <div className="text-caption text-muted truncate">
                      {activeConvo.scope === "deal"
                        ? "Чат за угодою"
                        : "Перед-угода"}
                    </div>
                  </div>
                  {/* Block / unblock — disabled if counterparty did the
                      blocking (only blocker lifts per spec semantics). */}
                  {activeConvo.status === "active" &&
                    (activeConvo.blocked_by === me.id ||
                      activeConvo.blocked_by === null) && (
                      <Button
                        size="sm"
                        variant={
                          activeConvo.blocked_by ? "secondary" : "ghost"
                        }
                        onClick={toggleBlock}
                      >
                        {activeConvo.blocked_by
                          ? "Розблокувати"
                          : "Заблокувати"}
                      </Button>
                    )}
                </header>

                {activeConvo.blocked_by && (
                  <div className="px-5 pt-4">
                    <ContactInfoBlockBanner
                      mode={
                        activeConvo.blocked_by === me.id
                          ? "blocked"
                          : "blocked_pending_admin"
                      }
                    />
                  </div>
                )}

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
                      const isOwn = m.sender_id === me.id;
                      const ageMs =
                        Date.now() - new Date(m.created_at).getTime();
                      const editable =
                        isOwn &&
                        !m.deleted_at &&
                        ageMs < 10 * 60 * 1000 &&
                        activeConvo.status === "active";
                      const isEditing = editingId === m.id;
                      return (
                        <div key={m.id} className="group">
                          {isEditing ? (
                            <div className="ml-auto max-w-[min(70%,560px)] border border-accent rounded-[var(--radius-md)] bg-paper p-3">
                              <textarea
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                rows={3}
                                maxLength={4000}
                                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-hairline bg-canvas text-body text-ink focus:outline-none focus:border-accent"
                                aria-label="Редагування повідомлення"
                              />
                              <div className="flex items-center justify-end gap-2 mt-2">
                                <button
                                  type="button"
                                  className="text-caption text-muted hover:text-ink"
                                  onClick={() => {
                                    setEditingId(null);
                                    setEditDraft("");
                                  }}
                                >
                                  Скасувати
                                </button>
                                <button
                                  type="button"
                                  className="text-caption text-accent font-medium hover:underline"
                                  onClick={() => submitEdit(m.id)}
                                >
                                  Зберегти
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <MessageBubble
                                groupedWithPrev={grouped}
                                data={{
                                  id: m.id,
                                  body: m.deleted_at
                                    ? "[повідомлення видалено]"
                                    : m.body,
                                  createdAt: m.created_at,
                                  senderIsMe: isOwn,
                                  senderName: isOwn
                                    ? me.display_name
                                    : activeConvo.counterparty?.display_name,
                                  senderAvatarUrl: isOwn
                                    ? me.avatar_url
                                    : activeConvo.counterparty?.avatar_url,
                                  delivery: "sent",
                                  gdprErased: !!m.gdpr_erased_at,
                                  autoRedacted: m.body_scrubbed,
                                  adminVisible: m.admin_visible,
                                  edited: !!m.edited_at,
                                  attachments: m.attachments?.map((a) => ({
                                    id: a.id,
                                    name: a.filename,
                                    thumbUrl: a.mime_type.startsWith("image/")
                                      ? getMediaStreamUrl(a.id)
                                      : undefined,
                                  })),
                                }}
                              />
                              {editable && (
                                <div className="ml-auto flex items-center gap-3 max-w-[min(70%,560px)] mt-0.5 pr-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity text-caption text-muted">
                                  <button
                                    type="button"
                                    className="hover:text-ink"
                                    onClick={() => {
                                      setEditingId(m.id);
                                      setEditDraft(m.body ?? "");
                                    }}
                                  >
                                    Редагувати
                                  </button>
                                  <button
                                    type="button"
                                    className="hover:text-danger"
                                    onClick={() => doDelete(m.id)}
                                  >
                                    Видалити
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
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
                    loading={sending || uploader.uploading}
                    blocked={
                      activeConvo.status !== "active" ||
                      !!activeConvo.blocked_by
                    }
                    maxLength={4000}
                    contactInfoDetected={draftHasContact}
                    attachments={composerAttachments}
                    onAttachmentsAdd={(files) => uploader.addFiles(files)}
                    onAttachmentRemove={(id) => uploader.removeFile(id)}
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
