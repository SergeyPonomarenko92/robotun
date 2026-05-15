/**
 * Module 9 — Web Push subscription management.
 *
 * Endpoints:
 *   GET    /api/v1/push/vapid-public-key   — anonymous; FE pulls before
 *                                            calling pushManager.subscribe().
 *   POST   /api/v1/me/push/subscribe       — authenticated; FE sends the
 *                                            browser-issued PushSubscription
 *                                            JSON. Idempotent upsert.
 *   DELETE /api/v1/me/push/subscribe       — authenticated; FE sends endpoint
 *                                            to unsubscribe a specific device.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/push.service.js";

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

export const pushRoutes: FastifyPluginAsync = async (server) => {
  server.get("/push/vapid-public-key", async () => {
    const key = svc.getVapidPublicKey();
    if (!key) return { error: "push_disabled" };
    return { public_key: key };
  });

  server.post(
    "/me/push/subscribe",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = subscribeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "validation_failed", fields: parsed.error.flatten().fieldErrors });
      }
      const r = await svc.subscribe({
        user_id: req.auth!.user_id,
        payload: parsed.data,
        user_agent: req.headers["user-agent"]?.toString().slice(0, 500) ?? null,
      });
      return reply.code(201).send(r);
    }
  );

  server.delete(
    "/me/push/subscribe",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = unsubscribeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const ok = await svc.unsubscribe({
        user_id: req.auth!.user_id,
        endpoint: parsed.data.endpoint,
      });
      if (!ok) return reply.code(404).send({ error: "subscription_not_found" });
      return { ok: true };
    }
  );
};
