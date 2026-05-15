-- Hand-written: Module 9 — Web Push subscriptions (VAPID).
-- FE service worker calls navigator.serviceWorker.pushManager.subscribe()
-- with the VAPID public key, sends the resulting PushSubscription JSON to
-- POST /me/push/subscribe. We persist (endpoint, p256dh, auth) and use
-- web-push to dispatch notifications.
--
-- Endpoint is unique per browser instance; UNIQUE(endpoint) lets the same
-- subscription idempotently re-register without dup rows. last_seen_at
-- tracks heartbeat — stale subscriptions (endpoint expired / browser
-- uninstalled) get garbage-collected by a cron sweep (TODO v2).

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_failed_at" timestamp with time zone,
  "failure_count" smallint NOT NULL DEFAULT 0
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_push_subscriptions_endpoint"
  ON "push_subscriptions" ("endpoint");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_user"
  ON "push_subscriptions" ("user_id");
