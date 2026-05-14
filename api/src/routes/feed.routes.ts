import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/feed.service.js";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  category_id: z.string().uuid().optional(),
  city: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export const feedRoutes: FastifyPluginAsync = async (server) => {
  server.get("/feed", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    return svc.listFeed(parsed.data);
  });
};
