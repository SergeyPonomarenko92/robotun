import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, sql as dsql } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/admin.service.js";
import {
  runAllJobs,
  dealAutoComplete,
  dealPendingExpiry,
  disputeEscalation,
  disputeAutoRefund,
  kycExpiredSweep,
  kycStaleClaim,
  outboxRetention,
  listingDraftExpiry,
  sessionsPurge,
  passwordResetTokensPurge,
} from "../services/cron.js";
import { scanRetrySweep, regenerateMissingVariants } from "../services/media.service.js";
import { drainEmailQueue } from "../services/notifications.service.js";
import { drainPushQueue } from "../services/push.service.js";

async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  required: ("admin" | "moderator")[] = ["admin", "moderator"]
): Promise<boolean> {
  if (!req.auth) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  const r = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, req.auth.user_id));
  const ok = r.some((x) => required.includes(x.role as "admin" | "moderator"));
  if (!ok) {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

const suspendSchema = z.object({ reason: z.string().min(1).max(1000) });

export const adminRoutes: FastifyPluginAsync = async (server) => {
  server.get("/admin/queue", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query ?? {});
    return svc.unifiedQueue(q);
  });

  server.get("/admin/stats", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return svc.platformStats();
  });

  // Ops-facing queue/health metrics. Different from /admin/stats which is
  // product-shaped (deals/users/etc.); this surfaces infrastructure health:
  // pending work, recent failures, oldest stuck items. Polling-safe (read-
  // only aggregate queries, no FOR UPDATE).
  server.get("/admin/metrics", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const rows = await dsql.unsafe(`
      SELECT
        -- outbox_pending = rows the in_app notifications consumer has not
        -- crossed yet (last_seen_id is the high-watermark). Returns full
        -- backlog if cursor row hasn't bootstrapped yet.
        (SELECT GREATEST(0, (SELECT COALESCE(MAX(id), 0) FROM outbox_events)
                          - COALESCE((SELECT last_seen_id FROM notification_consumer_cursors
                                       WHERE consumer_name = 'notifications:in_app'), 0))::int) AS outbox_pending,
        (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int
           FROM outbox_events WHERE id > COALESCE(
             (SELECT last_seen_id FROM notification_consumer_cursors
               WHERE consumer_name = 'notifications:in_app'), 0)) AS outbox_oldest_age_seconds,
        (SELECT COUNT(*)::int FROM notifications WHERE channel = 'email' AND status = 'pending') AS email_pending,
        (SELECT COUNT(*)::int FROM notifications WHERE channel = 'email' AND status = 'failed'
           AND created_at > now() - interval '24 hours') AS email_failed_24h,
        (SELECT COUNT(*)::int FROM notifications WHERE channel = 'email' AND status = 'sent'
           AND created_at > now() - interval '24 hours') AS email_sent_24h,
        (SELECT COUNT(*)::int FROM notifications WHERE channel = 'push' AND status = 'pending') AS push_pending,
        (SELECT COUNT(*)::int FROM notifications WHERE channel = 'push' AND status = 'failed'
           AND created_at > now() - interval '24 hours') AS push_failed_24h,
        (SELECT COUNT(*)::int FROM notifications WHERE channel = 'push' AND status = 'sent'
           AND created_at > now() - interval '24 hours') AS push_sent_24h,
        (SELECT COUNT(*)::int FROM push_subscriptions) AS push_subs_active,
        (SELECT COUNT(*)::int FROM media_objects WHERE status = 'awaiting_scan') AS scan_pending,
        (SELECT COUNT(*)::int FROM media_objects WHERE status = 'scan_error_permanent') AS scan_terminal,
        (SELECT COUNT(*)::int FROM media_objects WHERE status = 'quarantine_rejected'
           AND scan_completed_at > now() - interval '24 hours') AS scan_quarantined_24h,
        (SELECT COUNT(*)::int FROM media_objects WHERE status = 'ready'
           AND scan_completed_at > now() - interval '24 hours') AS scan_clean_24h,
        (SELECT COUNT(*)::int FROM deals WHERE status = 'pending') AS deals_pending,
        (SELECT COUNT(*)::int FROM deals WHERE status = 'in_review') AS deals_in_review,
        (SELECT COUNT(*)::int FROM deals WHERE status = 'disputed') AS deals_disputed,
        (SELECT COUNT(*)::int FROM kyc_verifications WHERE status IN ('submitted', 'in_review')) AS kyc_queue_depth
    `);
    return rows[0] ?? {};
  });

  server.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const r = await svc.userDetail(req.params.id);
      if (!r) return reply.code(404).send({ error: "user_not_found" });
      return r;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/users/:id/suspend",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const parsed = suspendSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.suspendUser({
        admin_id: req.auth!.user_id,
        target_user_id: req.params.id,
        reason: parsed.data.reason,
        ip: req.ip,
        ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/users/:id/activate",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const r = await svc.activateUser({
        admin_id: req.auth!.user_id,
        target_user_id: req.params.id,
        ip: req.ip,
        ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  // admin-only (moderators excluded from PII-bearing audit log).
  server.post("/admin/cron/run", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply, ["admin"]))) return;
    return runAllJobs();
  });

  // Individual job trigger — ops convenience for retrying a specific
  // worker without firing the full set (which costs a clamd connection
  // + SMTP verify on every press).
  const JOBS: Record<string, () => Promise<number>> = {
    deal_auto_complete: dealAutoComplete,
    deal_pending_expiry: dealPendingExpiry,
    dispute_escalation: disputeEscalation,
    dispute_auto_refund: disputeAutoRefund,
    kyc_expired_sweep: kycExpiredSweep,
    kyc_stale_claim: kycStaleClaim,
    outbox_retention: outboxRetention,
    listing_draft_expiry: listingDraftExpiry,
    media_scan_retry: scanRetrySweep,
    media_variants_backfill: regenerateMissingVariants,
    email_drain: drainEmailQueue,
    push_drain: drainPushQueue,
    sessions_purge: sessionsPurge,
    password_reset_tokens_purge: passwordResetTokensPurge,
  };
  server.post<{ Params: { job: string } }>(
    "/admin/cron/run/:job",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply, ["admin"]))) return;
      const fn = JOBS[req.params.job];
      if (!fn) return reply.code(404).send({ error: "unknown_job", known: Object.keys(JOBS) });
      const count = await fn();
      return { job: req.params.job, processed: count };
    }
  );

  server.get("/admin/actions", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply, ["admin"]))) return;
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        actor_id: z.string().uuid().optional(),
        target_user_id: z.string().uuid().optional(),
      })
      .parse(req.query ?? {});
    return svc.listAdminActions(q);
  });
};
