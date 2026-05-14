import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/messaging.service.js";

const openSchema = z.object({ listing_id: z.string().uuid() });
const sendSchema = z.object({ body: z.string().min(1).max(4000) });

export const messagingRoutes: FastifyPluginAsync = async (server) => {
  server.get("/conversations", { preHandler: server.authenticate }, async (req) => {
    return svc.listMine(req.auth!.user_id);
  });

  server.post(
    "/conversations",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = openSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.openPreDealConversation({ user_id: req.auth!.user_id, listing_id: parsed.data.listing_id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(r.value.created ? 201 : 200).send(r.value);
    }
  );

  server.get<{ Params: { id: string } }>(
    "/conversations/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.getConversation(req.auth!.user_id, req.params.id);
      if (!r) return reply.code(404).send({ error: "conversation_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "conversation_not_found" });
      return r;
    }
  );

  server.get<{ Params: { id: string } }>(
    "/conversations/:id/messages",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().optional(),
        })
        .parse(req.query ?? {});
      const r = await svc.listMessages(req.auth!.user_id, req.params.id, q);
      if (!r) return reply.code(404).send({ error: "conversation_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "conversation_not_found" });
      if (r === "invalid_cursor") return reply.code(400).send({ error: "invalid_cursor" });
      return r;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/conversations/:id/messages",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.sendMessage({ user_id: req.auth!.user_id, conversation_id: req.params.id, body: parsed.data.body });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/conversations/:id/read",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.markRead(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );
};
