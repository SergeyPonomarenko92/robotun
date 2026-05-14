import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/notifications.service.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread_only: z.coerce.boolean().default(false),
});

const prefSchema = z.object({
  notification_code: z.string().min(1).max(80),
  channel: z.enum(["in_app", "email"]).default("in_app"),
  enabled: z.boolean(),
});

export const notificationsRoutes: FastifyPluginAsync = async (server) => {
  server.get("/notifications", { preHandler: server.authenticate }, async (req) => {
    const q = listQuery.parse(req.query ?? {});
    return svc.listMine(req.auth!.user_id, q);
  });

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
      await svc.setPreference(req.auth!.user_id, parsed.data.notification_code, parsed.data.channel, parsed.data.enabled);
      return { ok: true };
    }
  );

  // Admin/dev: drain outbox synchronously. Useful for tests; production
  // path is the background worker.
  server.post("/admin/notifications/drain", { preHandler: server.authenticate }, async (req, reply) => {
    if (req.auth!.status !== "active") return reply.code(403).send({ error: "forbidden" });
    const n = await svc.consumeOutboxOnce();
    return { processed: n };
  });
};
