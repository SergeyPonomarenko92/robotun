/**
 * Module 9 mock — in-app notifications inbox.
 *
 * Real backend: Notifications worker consumes outbox events, fans out per
 * delivery channel, persists rows into `notifications` with idempotent
 * dedup. Mock skips the worker abstraction: producers (deals, messages,
 * kyc, payments) call enqueueNotification() directly.
 */

export type NotificationAggregateType =
  | "deal"
  | "review"
  | "user"
  | "message"
  | "conversation"
  | "payment"
  | "payout"
  | "refund"
  | "chargeback"
  | "wallet";

export type MockNotification = {
  id: string;
  user_id: string;
  notification_code: string;
  aggregate_type: NotificationAggregateType;
  aggregate_id: string | null;
  title: string;
  body: string | null;
  href: string | null;
  mandatory: boolean;
  read_at: string | null;
  created_at: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __ROBOTUN_NOTIFICATIONS__: MockNotification[] | undefined;
}
function db(): MockNotification[] {
  if (!globalThis.__ROBOTUN_NOTIFICATIONS__) {
    globalThis.__ROBOTUN_NOTIFICATIONS__ = [];
  }
  return globalThis.__ROBOTUN_NOTIFICATIONS__;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

export type EnqueueInput = {
  user_id: string;
  notification_code: string;
  aggregate_type: NotificationAggregateType;
  aggregate_id?: string | null;
  title: string;
  body?: string;
  href?: string;
  mandatory?: boolean;
  /** Dedup key (mirrors UNIQUE constraint REQ-003). When set, repeated
   *  enqueues with the same key collapse to one row. */
  source_event_id?: string;
};

export function enqueueNotification(input: EnqueueInput): MockNotification {
  if (input.source_event_id) {
    const existing = db().find(
      (n) =>
        n.user_id === input.user_id &&
        n.notification_code === input.notification_code &&
        (n.aggregate_id ?? "") === (input.aggregate_id ?? "")
    );
    if (existing) return existing;
  }
  const row: MockNotification = {
    id: uuid(),
    user_id: input.user_id,
    notification_code: input.notification_code,
    aggregate_type: input.aggregate_type,
    aggregate_id: input.aggregate_id ?? null,
    title: input.title,
    body: input.body ?? null,
    href: input.href ?? null,
    mandatory: input.mandatory ?? false,
    read_at: null,
    created_at: new Date().toISOString(),
  };
  db().push(row);
  return row;
}

export function listForUser(opts: {
  user_id: string;
  limit?: number;
  cursor?: string | null;
}): { items: MockNotification[]; next_cursor: string | null } {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const all = db()
    .filter((n) => n.user_id === opts.user_id)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  let start = 0;
  if (opts.cursor) {
    const idx = all.findIndex((n) => n.id === opts.cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = all.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const hasMore = start + limit < all.length;
  return {
    items: slice,
    next_cursor: hasMore && last ? last.id : null,
  };
}

export function unreadCountForUser(user_id: string): number {
  let n = 0;
  for (const row of db()) {
    if (row.user_id !== user_id) continue;
    if (row.read_at === null) n++;
  }
  return n;
}

export function markRead(
  user_id: string,
  notification_id: string
): MockNotification | null {
  const row = db().find((n) => n.id === notification_id && n.user_id === user_id);
  if (!row) return null;
  if (row.read_at === null) row.read_at = new Date().toISOString();
  return row;
}

export function markAllRead(user_id: string): number {
  const ts = new Date().toISOString();
  let n = 0;
  for (const row of db()) {
    if (row.user_id !== user_id || row.read_at !== null) continue;
    row.read_at = ts;
    n++;
  }
  return n;
}
