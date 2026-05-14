"use client";
import * as React from "react";
import { apiFetch, ApiError } from "./api";

export type ConversationScope = "pre_deal" | "deal";

export type ConversationCounterparty = {
  id: string;
  display_name: string;
  avatar_url?: string;
  kyc_verified: boolean;
};

export type Conversation = {
  id: string;
  scope: ConversationScope;
  listing_id: string | null;
  deal_id: string | null;
  status: "active" | "locked" | "archived";
  counterparty: ConversationCounterparty | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  /** User id who set the block (null = not blocked). Same caller can lift. */
  blocked_by: string | null;
  created_at: string;
};

export type MessageAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  status: "awaiting_upload" | "awaiting_scan" | "ready" | "quarantine_rejected" | "scan_error_permanent" | "deleted";
};

export type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  body_scrubbed: boolean;
  contact_info_detected: boolean;
  admin_visible: boolean;
  attachment_ids: string[];
  attachments?: MessageAttachment[];
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  gdpr_erased_at: string | null;
};

export type SendError = {
  status: number;
  code: string;
  message: string;
};

function localizeSendError(e: ApiError): SendError {
  const body = e.body as { error?: string } | null;
  const code = body?.error ?? "unknown";
  const message =
    code === "body_too_long"
      ? "Повідомлення задовге (макс. 4000 символів)"
      : code === "body_empty"
        ? "Порожнє повідомлення"
        : code === "conversation_locked"
          ? "Бесіду закрито"
          : code === "blocked"
            ? "Бесіду заблоковано"
            : code === "too_many_attachments"
              ? "Не більше 5 вкладень за раз"
              : code === "attachments_size_exceeded"
                ? "Сумарний розмір вкладень — до 25 МБ"
                : code === "invalid_attachments"
                  ? "Один або кілька файлів недійсні — додайте знову"
                  : code === "edit_window_expired"
                    ? "Минув 10-хвилинний інтервал на правки"
                    : code === "not_sender"
                      ? "Лише автор може змінити чи видалити"
                      : code === "not_found"
                        ? "Не знайдено"
                        : e.message;
  return { status: e.status, code, message };
}

export async function sendMessage(
  conversationId: string,
  body: string,
  attachment_ids: string[] = []
): Promise<{ ok: true; message: Message } | { ok: false; error: SendError }> {
  try {
    const m = await apiFetch<Message>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ body, attachment_ids }),
      }
    );
    return { ok: true, message: m };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: localizeSendError(e) };
    return {
      ok: false,
      error: { status: 0, code: "network", message: "Немає з'єднання" },
    };
  }
}

export async function editMessageApi(
  conversationId: string,
  messageId: string,
  body: string
): Promise<{ ok: true; message: Message } | { ok: false; error: SendError }> {
  try {
    const m = await apiFetch<Message>(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PUT", body: JSON.stringify({ body }) }
    );
    return { ok: true, message: m };
  } catch (e) {
    if (e instanceof ApiError) {
      const sendErr = localizeSendError(e);
      // Specialize edit-only error codes.
      const code = sendErr.code;
      if (code === "edit_window_expired") {
        return {
          ok: false,
          error: { ...sendErr, message: "Минув 10-хвилинний інтервал на правки" },
        };
      }
      if (code === "not_sender") {
        return {
          ok: false,
          error: { ...sendErr, message: "Лише автор може змінити повідомлення" },
        };
      }
      return { ok: false, error: sendErr };
    }
    return {
      ok: false,
      error: { status: 0, code: "network", message: "Немає з'єднання" },
    };
  }
}

export async function deleteMessageApi(
  conversationId: string,
  messageId: string
): Promise<{ ok: true } | { ok: false; error: SendError }> {
  try {
    await apiFetch(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: localizeSendError(e) };
    return {
      ok: false,
      error: { status: 0, code: "network", message: "Немає з'єднання" },
    };
  }
}

export async function markConversationRead(conversationId: string) {
  try {
    await apiFetch(
      `/conversations/${encodeURIComponent(conversationId)}/read-all`,
      { method: "POST" }
    );
  } catch {
    // best-effort; UI doesn't gate on this
  }
}

export async function blockConversationApi(conversationId: string) {
  return apiFetch(
    `/conversations/${encodeURIComponent(conversationId)}/block`,
    { method: "POST" }
  );
}
export async function unblockConversationApi(conversationId: string) {
  return apiFetch(
    `/conversations/${encodeURIComponent(conversationId)}/block`,
    { method: "DELETE" }
  );
}
export async function reportMessageApi(
  conversationId: string,
  messageId: string,
  reason: "spam" | "harassment" | "contact_info" | "inappropriate" | "other",
  note?: string
) {
  return apiFetch(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/report`,
    { method: "POST", body: JSON.stringify({ reason, note }) }
  );
}

export async function upsertConversation(
  input:
    | { scope: "pre_deal"; listing_id: string; counterparty_user_id: string }
    | { scope: "deal"; deal_id: string; counterparty_user_id: string }
): Promise<Conversation> {
  return apiFetch<Conversation>("/conversations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const POLL_MS = 4000;

export function useConversations() {
  const [items, setItems] = React.useState<Conversation[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);
  const refresh = React.useCallback(() => {
    apiFetch<{ items: Conversation[] }>("/conversations")
      .then((r) => mountedRef.current && setItems(r.items))
      .catch((e) => {
        if (!mountedRef.current) return;
        setError(e instanceof ApiError ? e.message : "network_error");
        setItems([]);
      });
  }, []);
  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return { items, error, refresh };
}

export function useConversationMessages(conversationId: string | null) {
  const [items, setItems] = React.useState<Message[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  const fetchOnce = React.useCallback(async () => {
    if (!conversationId) return;
    try {
      const r = await apiFetch<{ items: Message[]; next_cursor: string | null }>(
        `/conversations/${encodeURIComponent(conversationId)}/messages`
      );
      if (mountedRef.current) setItems(r.items);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : "network_error");
      setItems([]);
    }
  }, [conversationId]);

  React.useEffect(() => {
    setItems(null);
    setError(null);
    if (!conversationId) return;
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => clearInterval(t);
  }, [conversationId, fetchOnce]);

  // Optimistic append used when local send succeeds — avoids waiting 4s for
  // the next poll to surface the just-sent message.
  const append = React.useCallback((m: Message) => {
    setItems((prev) => {
      if (!prev) return [m];
      if (prev.some((x) => x.id === m.id)) return prev;
      return [...prev, m];
    });
  }, []);

  return { items, error, refresh: fetchOnce, append };
}
