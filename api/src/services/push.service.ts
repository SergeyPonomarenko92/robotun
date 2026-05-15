/**
 * Module 9 — Web Push channel (VAPID).
 *
 * FE service worker subscribes via PushManager → POSTs the
 * PushSubscription JSON to /me/push/subscribe. Each subscription is one
 * row keyed by endpoint (unique). Re-subscription from the same browser
 * upserts (touch last_seen_at).
 *
 * drainPushQueue pulls notifications channel='push' status='pending',
 * fans out to every active subscription of the recipient, dispatches via
 * web-push library. Per-subscription failures classified:
 *   - 410 Gone / 404 → subscription dead, delete row
 *   - 5xx / network → bump failure_count + last_failed_at, leave row
 *
 * If ALL subscriptions for a notification fail terminal → status='failed'.
 * If ANY succeed → status='sent'. Otherwise stays pending for backoff
 * retry (mirrors email channel).
 */
import webpush from "web-push";
import { and, eq, lte, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notifications, pushSubscriptions } from "../db/schema.js";
import { env } from "../config/env.js";

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return false;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export type SubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export async function subscribe(args: {
  user_id: string;
  payload: SubscriptionPayload;
  user_agent?: string | null;
}): Promise<{ id: string }> {
  // Upsert keyed by endpoint — same browser re-subscribing must idempotently
  // refresh last_seen_at without creating dup rows. user_id reassignment
  // (someone else's browser, same endpoint reused) takes the new owner.
  const r = await db.execute<{ id: string }>(
    dsql`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
         VALUES (${args.user_id}, ${args.payload.endpoint},
                 ${args.payload.keys.p256dh}, ${args.payload.keys.auth},
                 ${args.user_agent ?? null}, now())
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               user_agent = EXCLUDED.user_agent,
               last_seen_at = now(),
               failure_count = 0,
               last_failed_at = NULL
         RETURNING id`
  );
  return { id: r[0]!.id };
}

export async function unsubscribe(args: { user_id: string; endpoint: string }): Promise<boolean> {
  const r = await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.endpoint, args.endpoint), eq(pushSubscriptions.user_id, args.user_id))
    )
    .returning({ id: pushSubscriptions.id });
  return r.length > 0;
}

export function getVapidPublicKey(): string {
  return env.VAPID_PUBLIC_KEY;
}

const PUSH_MAX_FAILURES = 3;

/**
 * Drain pending push notifications. Mirrors drainEmailQueue shape but
 * fans out per-subscription (a user may have multiple devices).
 */
export async function drainPushQueue(): Promise<number> {
  if (!ensureConfigured()) {
    return 0; // no VAPID keys — silently skip; cron logs at debug level only.
  }

  const due = await db.execute<{
    id: string;
    recipient_user_id: string;
    title: string;
    body: string;
    notification_code: string;
    aggregate_id: string;
    delivery_attempts: number;
  }>(
    dsql`SELECT id, recipient_user_id, title, body, notification_code, aggregate_id, delivery_attempts
           FROM notifications
          WHERE channel = 'push' AND status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY created_at
          LIMIT 50
          FOR UPDATE SKIP LOCKED`
  );

  let sentRows = 0;
  for (const n of due) {
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, n.recipient_user_id));

    if (subs.length === 0) {
      // No subscriptions — skip terminally (user disabled, never installed).
      await db
        .update(notifications)
        .set({ status: "skipped", delivery_attempts: n.delivery_attempts + 1 })
        .where(eq(notifications.id, n.id));
      continue;
    }

    const payload = JSON.stringify({
      title: n.title,
      body: n.body,
      code: n.notification_code,
      aggregate_id: n.aggregate_id,
    });

    let anySuccess = false;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 24 * 3600 }
        );
        anySuccess = true;
        // Reset failure stats on success.
        await db
          .update(pushSubscriptions)
          .set({ last_seen_at: new Date(), failure_count: 0, last_failed_at: null })
          .where(eq(pushSubscriptions.id, s.id));
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Subscription dead — endpoint expired. Remove row.
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        } else {
          // Transient (network, 5xx, timeout). Bump counter; reap stale
          // subscriptions via a separate sweep (TODO v2).
          await db
            .update(pushSubscriptions)
            .set({
              failure_count: dsql`failure_count + 1`,
              last_failed_at: new Date(),
            })
            .where(eq(pushSubscriptions.id, s.id));
        }
      }
    }

    if (anySuccess) {
      await db
        .update(notifications)
        .set({ status: "sent", delivery_attempts: n.delivery_attempts + 1 })
        .where(eq(notifications.id, n.id));
      sentRows += 1;
    } else {
      const newAttempts = n.delivery_attempts + 1;
      if (newAttempts >= PUSH_MAX_FAILURES) {
        await db
          .update(notifications)
          .set({ status: "failed", delivery_attempts: newAttempts })
          .where(eq(notifications.id, n.id));
      } else {
        const backoff = 30 * Math.pow(4, newAttempts - 1); // 30s, 2m, 8m
        await db
          .update(notifications)
          .set({
            delivery_attempts: newAttempts,
            next_retry_at: new Date(Date.now() + backoff * 1000),
          })
          .where(eq(notifications.id, n.id));
      }
    }
  }

  // Reap subscriptions that have been failing for >7 days.
  const week = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        // failure_count >= PUSH_MAX_FAILURES, last_failed_at older than week
        eq(pushSubscriptions.failure_count, PUSH_MAX_FAILURES),
        lte(pushSubscriptions.last_failed_at, week)
      )
    );

  return sentRows;
}
