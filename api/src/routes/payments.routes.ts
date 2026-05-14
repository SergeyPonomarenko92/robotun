import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/payments.service.js";

const payoutReqSchema = z.object({
  amount_kopecks: z.number().int().positive(),
  target_last4: z.string().regex(/^\d{4}$/).optional(),
});

const failSchema = z.object({ reason: z.string().min(1).max(500) });

async function requireAdmin(userId: string) {
  const r = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, userId));
  return r.some((x) => x.role === "admin");
}

export const paymentsRoutes: FastifyPluginAsync = async (server) => {
  server.get<{ Params: { id: string } }>(
    "/deals/:id/payment",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.getDealPayment(req.auth!.user_id, req.params.id);
      if (!r) return reply.code(404).send({ error: "deal_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "deal_not_found" });
      return r;
    }
  );

  server.get("/wallet", { preHandler: server.authenticate }, async (req) => svc.getWallet(req.auth!.user_id));

  server.get("/payouts", { preHandler: server.authenticate }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query ?? {});
    return svc.listPayouts(req.auth!.user_id, q);
  });

  server.post("/payouts", { preHandler: server.authenticate }, async (req, reply) => {
    const parsed = payoutReqSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", fields: parsed.error.flatten().fieldErrors });
    const r = await svc.requestPayout({ provider_id: req.auth!.user_id, ...parsed.data });
    if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
    return reply.code(201).send(r.value);
  });

  server.post<{ Params: { id: string } }>(
    "/admin/payouts/:id/complete",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const r = await svc.markPayoutCompleted({ payout_id: req.params.id, admin_id: req.auth!.user_id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/payouts/:id/fail",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const parsed = failSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.markPayoutFailed({ payout_id: req.params.id, admin_id: req.auth!.user_id, reason: parsed.data.reason });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );
};
