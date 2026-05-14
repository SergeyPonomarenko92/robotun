import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { sql } from "./db/client.js";
import authenticate from "./plugins/authenticate.js";
import { authRoutes, usersRoutes } from "./routes/auth.routes.js";

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
  await server.register(sensible);
  await server.register(authenticate);

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

  await server.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(usersRoutes);
    },
    { prefix: "/api/v1" }
  );

  return server;
}
