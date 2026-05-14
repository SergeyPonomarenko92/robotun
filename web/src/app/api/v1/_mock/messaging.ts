/**
 * Module 2 (Messaging) mock — conversations + messages.
 *
 * Mirrors spec §4.5 endpoint contract but skips Postgres-specific
 * concerns (advisory locks, SSE pub/sub, FTS index, outbox emit, GDPR
 * sweep). Realtime is simulated by short-polling on the client side.
 */

export type ConversationScope = "pre_deal" | "deal";

export type MockConversation = {
  id: string;
  scope: ConversationScope;
  client_id: string;
  provider_id: string;
  listing_id: string | null;
  deal_id: string | null;
  status: "active" | "locked" | "archived";
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
};

export type MockMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  body_scrubbed: boolean;
  contact_info_detected: boolean;
  admin_visible: boolean;
  attachment_ids: string[];
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  gdpr_erased_at: string | null;
};

// REQ-005: 10-min edit/delete window for sender.
const EDIT_WINDOW_MS = 10 * 60 * 1000;
// REQ-013: per-message attachment caps.
const ATTACHMENT_MAX_COUNT = 5;
const ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type MessageReport = {
  id: string;
  conversation_id: string;
  message_id: string;
  reporter_id: string;
  reason: "spam" | "harassment" | "contact_info" | "inappropriate" | "other";
  note: string | null;
  status: "open" | "actioned" | "dismissed";
  created_at: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_MESSAGING__:
    | {
        conversations: Map<string, MockConversation>;
        messages: Map<string, MockMessage[]>;
        readMarks: Map<string, string>; // key=user_id+":"+convo_id → ISO ts
        // Conversation-level blocks. Key=convo_id; value=user_id of blocker.
        blocks: Map<string, string>;
        reports: MessageReport[];
        // Per-user rolling 7d window of contact-info hits per REQ-011.
        contactHits: Map<string, string[]>; // user_id → ISO ts[]
      }
    | undefined;
}

function db() {
  if (!globalThis.__ROBOTUN_MESSAGING__) {
    globalThis.__ROBOTUN_MESSAGING__ = {
      conversations: new Map(),
      messages: new Map(),
      readMarks: new Map(),
      blocks: new Map(),
      reports: [],
      contactHits: new Map(),
    };
  }
  return globalThis.__ROBOTUN_MESSAGING__;
}

// ---------------------------------------------------------------------------
// Contact-info detection (REQ-011 — simplified mock).
// ---------------------------------------------------------------------------
// Detects bare phones (UA + intl), emails, telegram/instagram handles,
// http(s) URLs. Real backend uses a more robust grammar; mock-grade is
// enough to exercise the auto-redact + auto-block UI states.
const CONTACT_PATTERNS: RegExp[] = [
  /\+?\d[\d\s\-()]{8,}\d/, // phone (10+ digits with optional separators)
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i, // email
  /@[a-z0-9_]{4,}/i, // telegram/instagram-style handle
  /(?:https?:\/\/|www\.)\S+/i, // URLs
  /viber|whatsapp|telegram|тел[\.:]/i, // contact channel mentions
];

export function detectContactInfo(body: string): boolean {
  return CONTACT_PATTERNS.some((re) => re.test(body));
}

function redactBody(body: string): string {
  let out = body;
  for (const re of CONTACT_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags + "g"), "▒▒▒");
  }
  return out;
}

const CONTACT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONTACT_HIT_THRESHOLD = 5;

function recordContactHit(userId: string): number {
  const now = Date.now();
  const arr = (db().contactHits.get(userId) ?? []).filter(
    (ts) => now - new Date(ts).getTime() < CONTACT_WINDOW_MS
  );
  arr.push(new Date(now).toISOString());
  db().contactHits.set(userId, arr);
  return arr.length;
}

// ---------------------------------------------------------------------------
// Block / unblock (REQ-?; supports two-party block per spec §4).
// ---------------------------------------------------------------------------
export function blockConversation(
  convoId: string,
  blockerId: string
): boolean {
  const c = db().conversations.get(convoId);
  if (!c || !isParty(c, blockerId)) return false;
  db().blocks.set(convoId, blockerId);
  return true;
}
export function unblockConversation(
  convoId: string,
  callerId: string
): boolean {
  const blockerId = db().blocks.get(convoId);
  if (!blockerId) return false;
  // Only the user who set the block can lift it (spec semantics).
  if (blockerId !== callerId) return false;
  db().blocks.delete(convoId);
  return true;
}
export function blockerOf(convoId: string): string | null {
  return db().blocks.get(convoId) ?? null;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export type ReportInput = {
  conversation_id: string;
  message_id: string;
  reporter_id: string;
  reason: MessageReport["reason"];
  note?: string | null;
};
export function reportMessage(
  input: ReportInput
): { ok: true; report: MessageReport } | { ok: false; error: "not_found" | "not_party" } {
  const c = db().conversations.get(input.conversation_id);
  if (!c) return { ok: false, error: "not_found" };
  if (!isParty(c, input.reporter_id))
    return { ok: false, error: "not_party" };
  const list = db().messages.get(c.id) ?? [];
  const m = list.find((x) => x.id === input.message_id);
  if (!m) return { ok: false, error: "not_found" };
  const report: MessageReport = {
    id: uuid(),
    conversation_id: input.conversation_id,
    message_id: input.message_id,
    reporter_id: input.reporter_id,
    reason: input.reason,
    note: input.note ?? null,
    status: "open",
    created_at: new Date().toISOString(),
  };
  db().reports.push(report);
  return { ok: true, report };
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------------------
// Idempotent conversation upsert (REQ-003 UNIQUE on
// (scope, listing_id|deal_id, client_id, provider_id)).
// ---------------------------------------------------------------------------

export type CreateConversationInput =
  | {
      scope: "pre_deal";
      caller_user_id: string;
      counterparty_user_id: string;
      listing_id: string;
    }
  | {
      scope: "deal";
      caller_user_id: string;
      counterparty_user_id: string;
      deal_id: string;
    };

export function upsertConversation(
  input: CreateConversationInput
): MockConversation {
  // Client is whoever initiated; provider is counterparty. For pre_deal we
  // trust caller is the client (REQ-001). For deal-scoped both can initiate
  // and we keep whichever order; we sort to keep the UNIQUE key deterministic.
  const [client_id, provider_id] =
    input.scope === "pre_deal"
      ? [input.caller_user_id, input.counterparty_user_id]
      : [input.caller_user_id, input.counterparty_user_id].sort();

  const listing_id = input.scope === "pre_deal" ? input.listing_id : null;
  const deal_id = input.scope === "deal" ? input.deal_id : null;
  for (const c of db().conversations.values()) {
    if (
      c.scope === input.scope &&
      c.listing_id === listing_id &&
      c.deal_id === deal_id &&
      c.client_id === client_id &&
      c.provider_id === provider_id
    ) {
      return c;
    }
  }
  const c: MockConversation = {
    id: uuid(),
    scope: input.scope,
    client_id,
    provider_id,
    listing_id,
    deal_id,
    status: "active",
    last_message_at: null,
    last_message_preview: null,
    created_at: new Date().toISOString(),
  };
  db().conversations.set(c.id, c);
  db().messages.set(c.id, []);
  return c;
}

export function findConversation(id: string): MockConversation | undefined {
  return db().conversations.get(id);
}

export function isParty(c: MockConversation, userId: string): boolean {
  return c.client_id === userId || c.provider_id === userId;
}

export function listConversationsForUser(
  userId: string,
  scope?: ConversationScope
): MockConversation[] {
  const out: MockConversation[] = [];
  for (const c of db().conversations.values()) {
    if (!isParty(c, userId)) continue;
    if (scope && c.scope !== scope) continue;
    if (c.status === "archived") continue;
    out.push(c);
  }
  // last_message_at DESC NULLS LAST, tiebreak by created_at DESC.
  out.sort((a, b) => {
    const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    if (bt !== at) return bt - at;
    return (
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// Messages — listing + sending.
// ---------------------------------------------------------------------------

const BODY_MAX = 4000;

export type SendResult =
  | { ok: true; message: MockMessage; auto_blocked?: boolean }
  | {
      ok: false;
      error:
        | "body_too_long"
        | "body_empty"
        | "conversation_locked"
        | "not_party"
        | "blocked"
        | "too_many_attachments"
        | "attachments_size_exceeded"
        | "invalid_attachments";
    };

export function sendMessage(input: {
  conversation_id: string;
  sender_id: string;
  body: string;
  attachment_ids?: string[];
  /** Hook injected by the route to verify attachment ownership / purpose /
   *  status without circular imports between messaging ↔ media. */
  validateAttachments?: (ids: readonly string[]) => {
    valid: boolean;
    total_bytes: number;
  };
}): SendResult {
  const c = db().conversations.get(input.conversation_id);
  if (!c || !isParty(c, input.sender_id)) {
    return { ok: false, error: "not_party" };
  }
  if (c.status === "locked" || c.status === "archived") {
    return { ok: false, error: "conversation_locked" };
  }
  if (db().blocks.has(c.id)) {
    return { ok: false, error: "blocked" };
  }
  const rawBody = input.body.trim();
  const attachmentIds = input.attachment_ids ?? [];
  // Allow attachment-only messages (image-only chat). Empty body only fails
  // when there are also no attachments.
  if (rawBody.length === 0 && attachmentIds.length === 0)
    return { ok: false, error: "body_empty" };
  if (rawBody.length > BODY_MAX) return { ok: false, error: "body_too_long" };
  if (attachmentIds.length > ATTACHMENT_MAX_COUNT)
    return { ok: false, error: "too_many_attachments" };
  if (attachmentIds.length > 0 && input.validateAttachments) {
    const v = input.validateAttachments(attachmentIds);
    if (!v.valid) return { ok: false, error: "invalid_attachments" };
    if (v.total_bytes > ATTACHMENT_MAX_TOTAL_BYTES)
      return { ok: false, error: "attachments_size_exceeded" };
  }

  // REQ-011: contact-info detection → auto-redact + count toward 5-in-7d
  // auto-block threshold. Mock auto-blocks the conversation when threshold
  // is reached (real impl gates the first auto-block on admin confirmation
  // via Module 9 queue).
  const hasContact = detectContactInfo(rawBody);
  const finalBody = hasContact ? redactBody(rawBody) : rawBody;
  let autoBlocked = false;
  if (hasContact) {
    const hits = recordContactHit(input.sender_id);
    if (hits >= CONTACT_HIT_THRESHOLD) {
      db().blocks.set(c.id, input.sender_id);
      autoBlocked = true;
    }
  }

  const m: MockMessage = {
    id: uuid(),
    conversation_id: c.id,
    sender_id: input.sender_id,
    body: finalBody.length === 0 ? null : finalBody,
    body_scrubbed: hasContact,
    contact_info_detected: hasContact,
    admin_visible: false,
    attachment_ids: attachmentIds,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    gdpr_erased_at: null,
  };
  const list = db().messages.get(c.id) ?? [];
  list.push(m);
  db().messages.set(c.id, list);
  c.last_message_at = m.created_at;
  c.last_message_preview = finalBody.slice(0, 120);

  // Module 9 producer hook: notify recipient (the non-sender party).
  // Dynamic import keeps messaging↔notifications coupling unidirectional
  // for the mock; real backend uses outbox events.
  const recipientId =
    c.client_id === input.sender_id ? c.provider_id : c.client_id;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const notif = require("./notifications") as typeof import("./notifications");
  notif.enqueueNotification({
    user_id: recipientId,
    notification_code: "message.created",
    aggregate_type: "message",
    aggregate_id: m.id,
    title: "Нове повідомлення",
    body: finalBody.length > 0 ? finalBody.slice(0, 120) : "Вкладення",
    href: `/messages?c=${c.id}`,
  });

  return { ok: true, message: m, auto_blocked: autoBlocked };
}

export type ListMessagesResult = {
  items: MockMessage[];
  next_cursor: string | null;
};

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

function encodeCursor(c: { ts: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8")
    .toString("base64")
    .replace(/=+$/, "");
}

function decodeCursor(s: string | null): { ts: string; id: string } | null {
  if (!s) return null;
  try {
    const raw = Buffer.from(s, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as { ts: string; id: string };
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string")
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listMessages(input: {
  conversation_id: string;
  caller_user_id: string;
  cursor?: string | null;
  limit?: number;
}): { ok: true; data: ListMessagesResult } | { ok: false; error: "not_found" | "not_party" } {
  const c = db().conversations.get(input.conversation_id);
  if (!c) return { ok: false, error: "not_found" };
  if (!isParty(c, input.caller_user_id))
    return { ok: false, error: "not_party" };
  const limit = Math.min(
    PAGE_MAX,
    Math.max(1, input.limit ?? PAGE_DEFAULT)
  );
  const all = (db().messages.get(c.id) ?? []).filter((m) => !m.deleted_at);
  // Spec REQ-006: cursor on (created_at, id) DESC. Cursor points to last seen;
  // return messages strictly older than cursor.
  const sortedDesc = [...all].sort((a, b) => {
    if (a.created_at !== b.created_at)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    return b.id.localeCompare(a.id);
  });
  const cur = decodeCursor(input.cursor ?? null);
  const startIdx = cur
    ? sortedDesc.findIndex(
        (m) =>
          new Date(m.created_at).getTime() < new Date(cur.ts).getTime() ||
          (m.created_at === cur.ts && m.id.localeCompare(cur.id) < 0)
      )
    : 0;
  const slice = startIdx === -1 ? [] : sortedDesc.slice(startIdx, startIdx + limit);
  const hasMore =
    startIdx >= 0 && startIdx + limit < sortedDesc.length;
  const last = slice[slice.length - 1];
  return {
    ok: true,
    data: {
      // Return chronological ASC for UI rendering (oldest→newest).
      items: slice.slice().reverse(),
      next_cursor:
        hasMore && last
          ? encodeCursor({ ts: last.created_at, id: last.id })
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Edit / delete within 10-min sender window (REQ-005).
// ---------------------------------------------------------------------------

export type EditResult =
  | { ok: true; message: MockMessage }
  | {
      ok: false;
      error:
        | "not_found"
        | "not_sender"
        | "edit_window_expired"
        | "body_empty"
        | "body_too_long"
        | "conversation_locked";
    };

function findMessageInConvo(
  convoId: string,
  msgId: string
): { c: MockConversation; m: MockMessage; idx: number } | null {
  const c = db().conversations.get(convoId);
  if (!c) return null;
  const list = db().messages.get(c.id) ?? [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx < 0) return null;
  return { c, m: list[idx], idx };
}

export function editMessage(input: {
  conversation_id: string;
  message_id: string;
  caller_id: string;
  body: string;
}): EditResult {
  const r = findMessageInConvo(input.conversation_id, input.message_id);
  if (!r) return { ok: false, error: "not_found" };
  if (r.m.sender_id !== input.caller_id)
    return { ok: false, error: "not_sender" };
  if (r.c.status !== "active")
    return { ok: false, error: "conversation_locked" };
  if (r.m.deleted_at) return { ok: false, error: "not_found" };
  const age = Date.now() - new Date(r.m.created_at).getTime();
  if (age > EDIT_WINDOW_MS)
    return { ok: false, error: "edit_window_expired" };
  const body = input.body.trim();
  if (body.length === 0) return { ok: false, error: "body_empty" };
  if (body.length > BODY_MAX) return { ok: false, error: "body_too_long" };
  // Re-run contact detection (an edit could introduce contacts).
  const hasContact = detectContactInfo(body);
  r.m.body = hasContact ? redactBody(body) : body;
  r.m.body_scrubbed = hasContact;
  r.m.contact_info_detected = hasContact;
  r.m.edited_at = new Date().toISOString();
  // Update preview if this was the most-recent message.
  const list = db().messages.get(r.c.id) ?? [];
  const last = list[list.length - 1];
  if (last && last.id === r.m.id) {
    r.c.last_message_preview = (r.m.body ?? "").slice(0, 120);
  }
  return { ok: true, message: r.m };
}

export type DeleteResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "not_found"
        | "not_sender"
        | "edit_window_expired"
        | "conversation_locked";
    };

export function deleteMessage(input: {
  conversation_id: string;
  message_id: string;
  caller_id: string;
}): DeleteResult {
  const r = findMessageInConvo(input.conversation_id, input.message_id);
  if (!r) return { ok: false, error: "not_found" };
  if (r.m.sender_id !== input.caller_id)
    return { ok: false, error: "not_sender" };
  if (r.c.status !== "active")
    return { ok: false, error: "conversation_locked" };
  if (r.m.deleted_at) return { ok: true }; // idempotent
  const age = Date.now() - new Date(r.m.created_at).getTime();
  if (age > EDIT_WINDOW_MS)
    return { ok: false, error: "edit_window_expired" };
  r.m.deleted_at = new Date().toISOString();
  r.m.body = null;
  // If this was the conversation's last message, recompute preview from the
  // most-recent surviving message.
  const list = (db().messages.get(r.c.id) ?? []).filter((m) => !m.deleted_at);
  const last = list[list.length - 1];
  r.c.last_message_at = last?.created_at ?? null;
  r.c.last_message_preview = last?.body?.slice(0, 120) ?? null;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Read marks (lazy unread counting per REQ-010, in-memory not Redis).
// ---------------------------------------------------------------------------

function readKey(userId: string, convoId: string): string {
  return userId + ":" + convoId;
}

export function markAllRead(userId: string, convoId: string): boolean {
  const c = db().conversations.get(convoId);
  if (!c || !isParty(c, userId)) return false;
  const lastTs = c.last_message_at ?? new Date().toISOString();
  db().readMarks.set(readKey(userId, convoId), lastTs);
  return true;
}

export function unreadCountFor(userId: string, convoId: string): number {
  const c = db().conversations.get(convoId);
  if (!c) return 0;
  const mark = db().readMarks.get(readKey(userId, convoId)) ?? "";
  const msgs = db().messages.get(convoId) ?? [];
  let n = 0;
  for (const m of msgs) {
    if (m.sender_id === userId) continue; // own messages don't count
    if (m.deleted_at) continue;
    if (m.created_at > mark) n++;
  }
  return n;
}
