import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { sql } from "./db/client.js";
import authenticate from "./plugins/authenticate.js";
import { authRoutes, usersRoutes } from "./routes/auth.routes.js";
import { categoriesRoutes } from "./routes/categories.routes.js";
import { listingsRoutes } from "./routes/listings.routes.js";
import { mediaRoutes } from "./routes/media.routes.js";
import { kycRoutes } from "./routes/kyc.routes.js";
import { dealsRoutes } from "./routes/deals.routes.js";
import { reviewsRoutes } from "./routes/reviews.routes.js";
import { notificationsRoutes } from "./routes/notifications.routes.js";
import { feedRoutes } from "./routes/feed.routes.js";
import { messagingRoutes } from "./routes/messaging.routes.js";
import { paymentsRoutes } from "./routes/payments.routes.js";
import { disputesRoutes } from "./routes/disputes.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { consumeOutboxOnce } from "./services/notifications.service.js";
import { startCronScheduler } from "./services/cron.js";
import { ensureBuckets } from "./services/s3.js";
import { ping as clamavPing } from "./services/clamav.js";
import { verifyConnection as smtpVerify } from "./services/email.js";

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
          : undefined,
    },
    disableRequestLogging: false,
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: true,
  });

  await server.register(helmet, { contentSecurityPolicy: false });
  await server.register(cors, {
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
  });
  // Global IP rate limit — abuse floor, not a per-user shaper. Most routes
  // are authenticated and tracked separately (login throttling, MFA challenge
  // issuance, etc. are already in their respective services). 240/min ≈ one
  // request every 250ms sustained, which covers normal SPA usage with room
  // for retries.
  await server.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: "1 minute",
    skipOnError: true, // do NOT 503 the API if Redis-backed store fails — degrade open.
    // In-memory store by default; multi-replica deploy should swap to Redis.
    allowList: (req) => req.url === "/health", // hot-poll endpoint must stay free.
  });
  await server.register(sensible);
  await server.register(authenticate);

  // Best-effort bucket bootstrap. MinIO in docker-compose; AWS S3 in prod
  // pre-provisions, so failures here are logged not fatal.
  ensureBuckets().catch((e) => {
    server.log.warn({ err: e }, "ensureBuckets failed");
  });

  // Cron scheduler — state-machine self-completion (auto-complete deals,
  // expire pending, escalate disputes, kyc expired/stale-claim, retention).
  if (env.NODE_ENV !== "test") {
    startCronScheduler(60);
  }

  // Notifications worker — polls outbox every 2s, drains to notifications.
  // Single-active via SELECT FOR UPDATE SKIP LOCKED; safe to run multiple
  // replicas (each will skip locked rows).
  if (env.NODE_ENV !== "test") {
    const tick = async () => {
      try { await consumeOutboxOnce(); } catch (e) { server.log.warn({ err: e }, "outbox consume tick failed"); }
    };
    const handle = setInterval(tick, 2000);
    handle.unref();
  }

  server.get("/health", async () => {
    const start = Date.now();
    let dbOk = false;
    try {
      await sql`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      uptime_seconds: Math.floor(process.uptime()),
      db_latency_ms: Date.now() - start,
      env: env.NODE_ENV,
    };
  });

  // Detailed health probe — exercises every external dependency. Slow
  // (clamav can take 100-500ms; SMTP can timeout on misconfig); not for
  // hot polling, use /health for that. Used by /admin and ops dashboards.
  server.get("/health/deep", async () => {
    const checks = await Promise.allSettled([
      sql`SELECT 1`.then(() => true).catch(() => false),
      clamavPing().catch(() => false),
      smtpVerify().catch(() => false),
    ]);
    const [db, clamav, smtp] = checks.map((c) =>
      c.status === "fulfilled" ? Boolean(c.value) : false
    );
    return {
      ok: Boolean(db && clamav && smtp),
      checks: { db, clamav, smtp },
      uptime_seconds: Math.floor(process.uptime()),
      env: env.NODE_ENV,
    };
  });

  await server.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(usersRoutes);
      await api.register(categoriesRoutes);
      await api.register(listingsRoutes);
      await api.register(mediaRoutes);
      await api.register(kycRoutes);
      await api.register(dealsRoutes);
      await api.register(reviewsRoutes);
      await api.register(notificationsRoutes);
      await api.register(feedRoutes);
      await api.register(messagingRoutes);
      await api.register(paymentsRoutes);
      await api.register(disputesRoutes);
      await api.register(adminRoutes);
    },
    { prefix: "/api/v1" }
  );

  return server;
}
