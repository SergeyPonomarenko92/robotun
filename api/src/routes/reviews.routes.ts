/**
 * Module 7 §4.9 — review REST endpoints (MVP cut).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/reviews.service.js";

const createSchema = z.object({
  deal_id: z.string().uuid(),
  overall_rating: z.number().int().min(1).max(5),
  quality_rating: z.number().int().min(1).max(5).nullable().optional(),
  communication_rating: z.number().int().min(1).max(5).nullable().optional(),
  timeliness_rating: z.number().int().min(1).max(5).nullable().optional(),
  comment: z.string().min(20).max(2000).nullable().optional(),
});

const replySchema = z.object({ body: z.string().min(1).max(2000) });

export const reviewsRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/reviews",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          fields: parsed.error.flatten().fieldErrors,
        });
      }
      const r = await svc.createReview({
        reviewer_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  server.get(
    "/reviews",
    async (req, reply) => {
      const q = z
        .object({
          listing_id: z.string().uuid().optional(),
          reviewee_id: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(10),
          cursor: z.string().optional(),
          rating: z.coerce.number().int().min(1).max(5).optional(),
        })
        .parse(req.query ?? {});
      if (q.listing_id) return svc.listForListing(q.listing_id, q);
      if (q.reviewee_id) return svc.listForUser(q.reviewee_id, q);
      return reply.code(400).send({ error: "missing_filter" });
    }
  );

  // Spec §4.9 — single-review fetch, anonymous-allowed. SEC-007 identical
  // 404 hides invisibility from non-existence.
  server.get<{ Params: { id: string } }>(
    "/reviews/:id",
    async (req, reply) => {
      const viewerId = (req.auth?.user_id as string | undefined) ?? null;
      const r = await svc.getById(viewerId, req.params.id);
      if (r === null) return reply.code(404).send({ error: "review_not_found" });
      return r;
    }
  );

  server.get<{ Params: { id: string } }>(
    "/listings/:id/reviews",
    async (req) => {
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
          cursor: z.string().optional(),
          rating: z.coerce.number().int().min(1).max(5).optional(),
        })
        .parse(req.query ?? {});
      const r = await svc.listForListing(req.params.id, q);
      const aggr = await svc.aggregatesFor("listing", req.params.id);
      return { ...r, ...aggr };
    }
  );

  server.get<{ Params: { id: string } }>(
    "/users/:id/reviews",
    async (req) => {
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
          cursor: z.string().optional(),
        })
        .parse(req.query ?? {});
      const r = await svc.listForUser(req.params.id, q);
      const aggr = await svc.aggregatesFor("user", req.params.id);
      return { ...r, ...aggr };
    }
  );

  server.get<{ Params: { id: string } }>(
    "/deals/:id/reviews",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.listForDeal(req.auth!.user_id, req.params.id);
      if (r === null) return reply.code(404).send({ error: "deal_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "deal_not_found" });
      return r;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/reviews/:id/replies",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = replySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.createReply({
        user_id: req.auth!.user_id,
        review_id: req.params.id,
        body: parsed.data.body,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );
};
