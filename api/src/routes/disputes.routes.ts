import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/disputes.service.js";

const respondSchema = z.object({
  // Spec REQ-003 / DSP-CON-006: statement required at submission. NULL is
  // reserved for GDPR-erased rows (DSP-CON-007).
  statement: z.string().min(30).max(4000),
  attachment_ids: z.array(z.string().uuid()).max(10).optional(),
});

const resolveSchema = z.object({
  outcome: z.enum(["release_to_provider", "refund_to_client", "split"]),
  release_amount_kopecks: z.number().int().nonnegative().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

async function isAdmin(userId: string): Promise<boolean> {
  const r = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, userId));
  return r.some((x) => x.role === "admin");
}

export const disputesRoutes: FastifyPluginAsync = async (server) => {
  // Note: client evidence is now written atomically inside /deals/:id/dispute
  // (deals.service.ts:disputeDeal). The previous standalone
  // /deals/:id/dispute/evidence endpoint was removed — see Module 14 fix
  // for REQ-003 violation.
  server.post<{ Params: { id: string } }>(
    "/deals/:id/dispute/respond",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = respondSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", fields: parsed.error.flatten().fieldErrors });
      const r = await svc.recordEvidence({
        deal_id: req.params.id,
        user_id: req.auth!.user_id,
        party_role: "provider",
        reason: "response",
        statement: parsed.data.statement ?? null,
        attachment_ids: parsed.data.attachment_ids,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  server.get<{ Params: { id: string } }>(
    "/deals/:id/evidence",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.listEvidence(req.auth!.user_id, req.params.id);
      if (!r) return reply.code(404).send({ error: "deal_not_found" });
      if (r === "forbidden") return reply.code(403).send({ error: "forbidden" });
      return r;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/deals/:id/resolve",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await isAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const parsed = resolveSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.resolveDispute({
        deal_id: req.params.id,
        admin_id: req.auth!.user_id,
        outcome: parsed.data.outcome,
        release_amount_kopecks: parsed.data.release_amount_kopecks ?? null,
        note: parsed.data.note ?? null,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );
};
