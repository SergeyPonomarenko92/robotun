/**
 * Module 3 §4.6 — deal REST endpoints (MVP cut).
 *
 * Transition endpoints accept `{ version: N }` and return 409 with current
 * version+status on conflict (optimistic concurrency).
 *
 * Idempotency-Key header required on POST /deals.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/deals.service.js";

const createSchema = z.object({
  provider_id: z.string().uuid(),
  category_id: z.string().uuid(),
  listing_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  agreed_price: z.number().int().positive(),
  deadline_at: z.string().datetime().nullable().optional(),
});

const versionSchema = z.object({ version: z.number().int().nonnegative() });

const disputeSchema = versionSchema.extend({
  reason: z.string().min(30).max(2000),
  attachment_ids: z.array(z.string().uuid()).min(1).max(10),
});

const listQuery = z.object({
  status: z.enum(["pending", "active", "in_review", "completed", "disputed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const dealsRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/deals",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const idemHeader = req.headers["idempotency-key"];
      const idem = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
      if (!idem || idem.length < 8 || idem.length > 80) {
        return reply.code(400).send({ error: "missing_idempotency_key" });
      }
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          fields: parsed.error.flatten().fieldErrors,
        });
      }
      const r = await svc.createDeal({
        client_id: req.auth!.user_id,
        idempotency_key: idem,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(r.value.replay ? 200 : 201).send({
        id: r.value.id,
        status: r.value.status,
        version: r.value.version,
      });
    }
  );

  server.get(
    "/deals",
    { preHandler: server.authenticate },
    async (req) => {
      const q = listQuery.parse(req.query ?? {});
      return svc.listMine(req.auth!.user_id, q);
    }
  );

  server.get<{ Params: { id: string } }>(
    "/deals/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.getDeal(req.auth!.user_id, req.params.id);
      if (r === null) return reply.code(404).send({ error: "deal_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "deal_not_found" });
      return r;
    }
  );

  server.get<{ Params: { id: string } }>(
    "/deals/:id/events",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.listEvents(req.auth!.user_id, req.params.id);
      if (r === null) return reply.code(404).send({ error: "deal_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "deal_not_found" });
      return r;
    }
  );

  // Generic transition factory.
  const transitions: Record<string, (id: string, actor: string, role: "client"|"provider"|"admin", v: number) => Promise<Awaited<ReturnType<typeof svc.acceptDeal>>>> = {
    accept: (id, a, r, v) => svc.acceptDeal({ deal_id: id, actor_id: a, actor_role: r, version: v }),
    reject: (id, a, r, v) => svc.rejectDeal({ deal_id: id, actor_id: a, actor_role: r, version: v }),
    submit: (id, a, r, v) => svc.submitDeal({ deal_id: id, actor_id: a, actor_role: r, version: v }),
    approve: (id, a, r, v) => svc.approveDeal({ deal_id: id, actor_id: a, actor_role: r, version: v }),
    cancel: (id, a, r, v) => svc.cancelDeal({ deal_id: id, actor_id: a, actor_role: r, version: v }),
  };

  for (const [action, fn] of Object.entries(transitions)) {
    server.post<{ Params: { id: string } }>(
      `/deals/:id/${action}`,
      { preHandler: server.authenticate },
      async (req, reply) => {
        const parsed = versionSchema.safeParse(req.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
        const r = await fn(req.params.id, req.auth!.user_id, "client", parsed.data.version);
        if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
        return r.value;
      }
    );
  }

  server.post<{ Params: { id: string } }>(
    "/deals/:id/dispute",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = disputeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "validation_failed", fields: parsed.error.flatten().fieldErrors });
      }
      const r = await svc.disputeDeal({
        deal_id: req.params.id,
        actor_id: req.auth!.user_id,
        actor_role: "client",
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );
};
