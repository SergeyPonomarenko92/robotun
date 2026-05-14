import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { sql } from "./db/client.js";

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
    bodyLimit: 1 * 1024 * 1024, // 1 MB — bumped per-route for media uploads later.
  });

  await server.register(helmet, { contentSecurityPolicy: false });
  await server.register(cors, {
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
  });
  await server.register(sensible);

  // Health probe — used by docker-compose / k8s readiness checks.
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

  // Module 1 routes appear in the next commit.
  server.get("/api/v1/_ping", async () => ({ pong: true }));

  return server;
}
