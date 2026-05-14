import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/notifications.service.js";

async function isAdmin(userId: string): Promise<boolean> {
  const r = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, userId));
  return r.some((x) => x.role === "admin");
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread_only: z.coerce.boolean().default(false),
  cursor: z.string().optional(),
});

const prefSchema = z.object({
  notification_code: z.string().min(1).max(80),
  channel: z.enum(["in_app", "email"]).default("in_app"),
  enabled: z.boolean(),
});

export const notificationsRoutes: FastifyPluginAsync = async (server) => {
  const listHandler = async (req: import("fastify").FastifyRequest) => {
    const q = listQuery.parse(req.query ?? {});
    return svc.listMine(req.auth!.user_id, q);
  };
  server.get("/notifications", { preHandler: server.authenticate }, listHandler);
  // FE-canonical path: /me/notifications.
  server.get("/me/notifications", { preHandler: server.authenticate }, listHandler);

  server.get("/notifications/unread-count", { preHandler: server.authenticate }, async (req) => {
    return { count: await svc.unreadCount(req.auth!.user_id) };
  });

  server.post<{ Params: { id: string } }>(
    "/notifications/:id/read",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.markRead(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.post("/notifications/read-all", { preHandler: server.authenticate }, async (req) => {
    return { marked: await svc.markAllRead(req.auth!.user_id) };
  });

  server.get("/notifications/preferences", { preHandler: server.authenticate }, async (req) => {
    return svc.listPreferences(req.auth!.user_id);
  });

  server.patch(
    "/notifications/preferences",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = prefSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.setPreference(req.auth!.user_id, parsed.data.notification_code, parsed.data.channel, parsed.data.enabled);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  // Admin/dev: drain outbox synchronously. Useful for tests; production
  // path is the background worker.
  // Admin-only synchronous drain (dev / tests).
  server.post("/admin/notifications/drain", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await isAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
    const n = await svc.consumeOutboxOnce();
    return { processed: n };
  });
};
