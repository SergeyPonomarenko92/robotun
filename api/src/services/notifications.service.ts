/**
 * Module 9 — Notifications (MVP cut).
 *
 * Polling worker drains outbox_events → notifications rows. Per-user
 * preferences override the in-app default (enabled=true). Email channel
 * deferred.
 */
import { and, desc, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ServiceErrorUsed = ServiceError;

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
const CONSUMER_NAME = "notifications:in_app";

/** Aggregate types Notifications cares about. Other consumers (e.g. payment
 *  capture worker) read from outbox independently via their own cursors. */
const AGGREGATE_ALLOWLIST = [
  "deal",
  "kyc",
  "review",
  "listing",
  "user",
  "message",
  "conversation",
  "payout",
];

/** Notification codes which the user CANNOT opt out of (legal / security). */
const MANDATORY_CODES = new Set([
  "kyc_approved",
  "kyc_rejected",
  "deal_disputed_for_provider",
]);

/**
 * One pass through outbox_events. Uses a per-consumer cursor (does NOT
 * mutate outbox_events.status — the outbox is shared infra). Returns
 * processed count.
 */
export async function consumeOutboxOnce(): Promise<number> {
  return await db.transaction(async (tx) => {
    // Single-active per consumer via FOR UPDATE on the cursor row.
    const cursorRows = await tx.execute<{ last_seen_id: number }>(
      dsql`SELECT last_seen_id FROM notification_consumer_cursors
            WHERE consumer_name = ${CONSUMER_NAME} FOR UPDATE`
    );
    if (cursorRows.length === 0) return 0; // cursor row missing — bootstrap.
    const lastSeen = Number(cursorRows[0]!.last_seen_id);

    // Hand-build the IN-list (constant, no user input) since drizzle's
    // template binds JS arrays as tuples rather than text[] literals.
    const allowlistSql = AGGREGATE_ALLOWLIST.map((t) => `'${t}'`).join(",");
    const rows = await tx.execute<{
      id: number;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      dsql`SELECT id, aggregate_type, aggregate_id, event_type, payload
             FROM outbox_events
            WHERE id > ${lastSeen}
              AND aggregate_type IN (${dsql.raw(allowlistSql)})
            ORDER BY id
            LIMIT ${BATCH}`
    );

    if (rows.length === 0) return 0;
    const maxId = rows[rows.length - 1]!.id;

    // Pre-resolve all recipients per row, then batch-load preferences for
    // the union of (user, code) pairs. Avoids per-recipient SELECT.
    type Plan = { row: typeof rows[number]; tpl: Template; recipients: string[] };
    const plans: Plan[] = [];
    // Cache admin list once per batch tick.
    let adminCache: string[] | null = null;
    const resolveAdmins = async () => {
      if (adminCache) return adminCache;
      const r = await tx.execute<{ user_id: string }>(
        dsql`SELECT user_id FROM user_roles WHERE role = 'admin'`
      );
      adminCache = r.map((x) => x.user_id);
      return adminCache;
    };

    for (const row of rows) {
      const tpl = TEMPLATES[row.event_type];
      if (!tpl) continue; // unknown event_type → just skip (cursor advances).
      // Special-case admin fan-out: resolve once.
      const recipients = tpl.code === "kyc_submitted_for_admins"
        ? await resolveAdmins()
        : await tpl.recipients(tx, row.payload);
      const uniq = Array.from(new Set(recipients.filter((r) => /^[0-9a-f-]{36}$/i.test(r))));
      if (uniq.length === 0) continue;
      plans.push({ row, tpl, recipients: uniq });
    }

    // Batched preferences fetch.
    const allUserIds = Array.from(new Set(plans.flatMap((p) => p.recipients)));
    const allCodes = Array.from(new Set(plans.map((p) => p.tpl.code)));
    let prefMap = new Map<string, boolean>();
    if (allUserIds.length > 0 && allCodes.length > 0) {
      // drizzle inArray binds each value as a separate $N param — works
      // around the "record vs array" cast issue without manual building.
      const prefRows = await tx
        .select({
          user_id: notificationPreferences.user_id,
          notification_code: notificationPreferences.notification_code,
          enabled: notificationPreferences.enabled,
        })
        .from(notificationPreferences)
        .where(
          and(
            inArray(notificationPreferences.user_id, allUserIds),
            inArray(notificationPreferences.notification_code, allCodes),
            eq(notificationPreferences.channel, "in_app")
          )
        );
      prefMap = new Map(prefRows.map((r) => [`${r.user_id}|${r.notification_code}`, r.enabled]));
    }

    let processed = 0;
    for (const plan of plans) {
      const ctx: TemplateCtx = { payload: plan.row.payload };
      for (const uid of plan.recipients) {
        // Mandatory codes bypass preferences (legal / security).
        const enabled = MANDATORY_CODES.has(plan.tpl.code)
          ? true
          : prefMap.get(`${uid}|${plan.tpl.code}`) ?? true;
        if (!enabled) continue;
        await tx.execute(
          dsql`INSERT INTO notifications
                  (recipient_user_id, source_event_id, aggregate_type, aggregate_id,
                   notification_code, channel, title, body, payload, status)
                VALUES (${uid}, ${plan.row.id}, ${plan.row.aggregate_type}, ${plan.row.aggregate_id},
                        ${plan.tpl.code}, 'in_app', ${plan.tpl.title(ctx)}, ${plan.tpl.body(ctx)},
                        ${JSON.stringify(plan.row.payload)}::jsonb, 'sent')
                ON CONFLICT DO NOTHING`
        );
      }
      processed++;
    }

    // Advance the cursor — outbox_events row stays untouched so other
    // consumers can independently read.
    await tx.execute(
      dsql`UPDATE notification_consumer_cursors
              SET last_seen_id = ${maxId}, updated_at = now()
            WHERE consumer_name = ${CONSUMER_NAME}`
    );
    return processed;
  });
}

/** Mandatory codes cannot be opted out via PATCH /preferences. */
export function isMandatoryCode(code: string): boolean {
  return MANDATORY_CODES.has(code);
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

export async function setPreference(userId: string, code: string, channel: string, enabled: boolean): Promise<Result<{ ok: true }>> {
  if (!enabled && isMandatoryCode(code)) {
    return { ok: false, error: { code: "cannot_opt_out_mandatory", status: 422 } };
  }
  await db.execute(
    dsql`INSERT INTO notification_preferences (user_id, notification_code, channel, enabled)
         VALUES (${userId}, ${code}, ${channel}, ${enabled})
         ON CONFLICT (user_id, notification_code, channel)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`
  );
  return { ok: true, value: { ok: true } };
}
