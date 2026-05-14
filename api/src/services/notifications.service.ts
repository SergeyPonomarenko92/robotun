/**
 * Module 9 — Notifications (MVP cut).
 *
 * Polling worker drains outbox_events → notifications rows. Per-user
 * preferences override the in-app default (enabled=true). Email channel
 * deferred.
 */
import { and, desc, eq, isNull, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  deals,
  notifications,
  notificationPreferences,
  outboxEvents,
  reviews,
  users,
} from "../db/schema.js";

type ServiceError = { code: string; status: number };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

/* --------------------------- template registry --------------------------- */

type TemplateCtx = { payload: Record<string, unknown> };
type Template = {
  code: string;
  title: (ctx: TemplateCtx) => string;
  body: (ctx: TemplateCtx) => string;
  /** Resolves recipient user_ids. */
  recipients: (tx: Tx, payload: Record<string, unknown>) => Promise<string[]>;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function dealParticipants(tx: Tx, dealId: string): Promise<{ client_id: string; provider_id: string } | null> {
  const r = await tx.select({ client_id: deals.client_id, provider_id: deals.provider_id })
    .from(deals).where(eq(deals.id, dealId)).limit(1);
  return r[0] ?? null;
}

const TEMPLATES: Record<string, Template> = {
  // Deal lifecycle — notify counterparty
  "deal.created": {
    code: "deal_new_for_provider",
    title: () => "Нова угода",
    body: (c) => `Клієнт запропонував угоду на ${((c.payload.agreed_price as number) ?? 0) / 100} грн.`,
    recipients: async (_tx, p) => [String(p.provider_id ?? "")].filter(Boolean),
  },
  "deal.activated": {
    code: "deal_activated_for_client",
    title: () => "Угоду активовано",
    body: () => "Виконавець прийняв угоду — escrow тримає кошти.",
    recipients: async (_tx, p) => [String(p.client_id ?? "")].filter(Boolean),
  },
  "deal.submitted": {
    code: "deal_submitted_for_client",
    title: () => "Роботу здано на перевірку",
    body: () => "У вас 7 днів, щоб підтвердити або оскаржити.",
    recipients: async (tx, p) => {
      const d = await dealParticipants(tx, String(p.deal_id));
      return d ? [d.client_id] : [];
    },
  },
  "deal.approved": {
    code: "deal_approved_for_provider",
    title: () => "Роботу підтверджено",
    body: () => "Клієнт підтвердив роботу. Кошти будуть звільнені.",
    recipients: async (tx, p) => {
      const d = await dealParticipants(tx, String(p.deal_id));
      return d ? [d.provider_id] : [];
    },
  },
  "deal.rejected": {
    code: "deal_rejected_for_client",
    title: () => "Угоду відхилено",
    body: () => "Виконавець не прийняв угоду.",
    recipients: async (tx, p) => {
      const d = await dealParticipants(tx, String(p.deal_id));
      return d ? [d.client_id] : [];
    },
  },
  "deal.disputed": {
    code: "deal_disputed_for_provider",
    title: () => "Відкрито спір по угоді",
    body: () => "Клієнт оскаржив виконання робіт. Очікуйте рішення.",
    recipients: async (tx, p) => {
      const d = await dealParticipants(tx, String(p.deal_id));
      return d ? [d.provider_id] : [];
    },
  },
  "deal.cancelled_mutual": {
    code: "deal_cancelled_mutual",
    title: () => "Угоду скасовано взаємно",
    body: () => "Обидві сторони погодились на скасування.",
    recipients: async (tx, p) => {
      const d = await dealParticipants(tx, String(p.deal_id));
      return d ? [d.client_id, d.provider_id] : [];
    },
  },
  "deal.cancelled_by_client": {
    code: "deal_cancelled_for_provider",
    title: () => "Клієнт скасував угоду",
    body: () => "Угода скасована до прийняття.",
    recipients: async (tx, p) => {
      const d = await dealParticipants(tx, String(p.deal_id));
      return d ? [d.provider_id] : [];
    },
  },
  "kyc.submitted": {
    code: "kyc_submitted_for_admins",
    title: () => "Нова KYC заявка",
    body: () => "Новий запит на верифікацію очікує перегляду.",
    // MVP: notify all admins.
    recipients: async (tx) => {
      const adminRows = await tx.execute<{ user_id: string }>(
        dsql`SELECT user_id FROM user_roles WHERE role = 'admin'`
      );
      return adminRows.map((r) => r.user_id);
    },
  },
  "kyc.approved": {
    code: "kyc_approved",
    title: () => "KYC схвалено",
    body: () => "Ваша верифікація успішно пройдена.",
    recipients: async (_tx, p) => [String(p.provider_id ?? "")].filter(Boolean),
  },
  "kyc.rejected": {
    code: "kyc_rejected",
    title: () => "KYC відхилено",
    body: (c) => `Причина: ${c.payload.rejection_code ?? "—"}. Можна подати повторно.`,
    recipients: async (_tx, p) => [String(p.provider_id ?? "")].filter(Boolean),
  },
  "review.submitted": {
    code: "review_for_reviewee",
    title: () => "Новий відгук",
    body: (c) => `Залишено відгук ${c.payload.overall_rating}/5.`,
    recipients: async (_tx, p) => [String(p.reviewee_id ?? "")].filter(Boolean),
  },
  "review.replied": {
    code: "review_replied_for_reviewer",
    title: () => "Відповідь на ваш відгук",
    body: () => "На ваш відгук залишено відповідь.",
    recipients: async (tx, p) => {
      const r = await tx
        .select({ reviewer_id: reviews.reviewer_id })
        .from(reviews)
        .where(eq(reviews.id, String(p.review_id)))
        .limit(1);
      return r[0]?.reviewer_id ? [r[0].reviewer_id] : [];
    },
  },
  "listing.created": {
    code: "listing_created_self",
    title: () => "Послугу опубліковано",
    body: () => "Ваша послуга з'явилась у каталозі.",
    recipients: async (_tx, p) => [String(p.provider_id ?? "")].filter(Boolean),
  },
};

/* ----------------------------- worker tick ------------------------------- */

const BATCH = 50;

/** One pass through outbox_events. Returns processed count. */
export async function consumeOutboxOnce(): Promise<number> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: number;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      dsql`SELECT id, aggregate_type, aggregate_id, event_type, payload
             FROM outbox_events
            WHERE status = 'pending' AND next_retry_at <= now()
            ORDER BY id
            FOR UPDATE SKIP LOCKED
            LIMIT ${BATCH}`
    );

    let processed = 0;
    for (const row of rows) {
      const tpl = TEMPLATES[row.event_type];
      if (!tpl) {
        await tx
          .update(outboxEvents)
          .set({ status: "processed", processed_at: new Date() })
          .where(eq(outboxEvents.id, row.id));
        processed++;
        continue;
      }

      const ctx: TemplateCtx = { payload: row.payload };
      const recipients = await tpl.recipients(tx, row.payload);
      const uniq = Array.from(new Set(recipients.filter((r) => /^[0-9a-f-]{36}$/i.test(r))));

      for (const uid of uniq) {
        // Preference check (default enabled).
        const prefRows = await tx
          .select({ enabled: notificationPreferences.enabled })
          .from(notificationPreferences)
          .where(
            and(
              eq(notificationPreferences.user_id, uid),
              eq(notificationPreferences.notification_code, tpl.code),
              eq(notificationPreferences.channel, "in_app")
            )
          )
          .limit(1);
        const enabled = prefRows.length === 0 ? true : prefRows[0]!.enabled;
        if (!enabled) continue;

        // Idempotent insert; dedupe by (source_event_id, user, channel, code).
        await tx.execute(
          dsql`INSERT INTO notifications
                  (recipient_user_id, source_event_id, aggregate_type, aggregate_id,
                   notification_code, channel, title, body, payload, status)
                VALUES (${uid}, ${row.id}, ${row.aggregate_type}, ${row.aggregate_id},
                        ${tpl.code}, 'in_app', ${tpl.title(ctx)}, ${tpl.body(ctx)},
                        ${JSON.stringify(row.payload)}::jsonb, 'sent')
                ON CONFLICT DO NOTHING`
        );
      }

      await tx
        .update(outboxEvents)
        .set({ status: "processed", processed_at: new Date() })
        .where(eq(outboxEvents.id, row.id));
      processed++;
    }
    return processed;
  });
}

/* ----------------------------- public reads ------------------------------ */

export async function listMine(userId: string, opts: { limit: number; unread_only?: boolean }) {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [eq(notifications.recipient_user_id, userId)];
  if (opts.unread_only) where.push(isNull(notifications.read_at));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...where))
    .orderBy(desc(notifications.created_at))
    .limit(limit);
  return { items: rows };
}

export async function unreadCount(userId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(
    dsql`SELECT COUNT(*)::int AS n FROM notifications
          WHERE recipient_user_id = ${userId} AND read_at IS NULL`
  );
  return r[0]?.n ?? 0;
}

export async function markRead(userId: string, notifId: string): Promise<Result<{ id: string }>> {
  const r = await db
    .update(notifications)
    .set({ read_at: new Date() })
    .where(and(eq(notifications.id, notifId), eq(notifications.recipient_user_id, userId)))
    .returning({ id: notifications.id });
  if (r.length === 0) return { ok: false, error: { code: "not_found", status: 404 } };
  return { ok: true, value: { id: notifId } };
}

export async function markAllRead(userId: string): Promise<number> {
  const r = await db
    .update(notifications)
    .set({ read_at: new Date() })
    .where(and(eq(notifications.recipient_user_id, userId), isNull(notifications.read_at)))
    .returning({ id: notifications.id });
  return r.length;
}

export async function listPreferences(userId: string) {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.user_id, userId));
  return { items: rows };
}

export async function setPreference(userId: string, code: string, channel: string, enabled: boolean) {
  await db.execute(
    dsql`INSERT INTO notification_preferences (user_id, notification_code, channel, enabled)
         VALUES (${userId}, ${code}, ${channel}, ${enabled})
         ON CONFLICT (user_id, notification_code, channel)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`
  );
}
