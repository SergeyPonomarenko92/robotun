/**
 * Module 4 §4.8 — KYC REST endpoints (MVP cut).
 *
 * Document upload uses Module 6 Media pipeline directly:
 *   POST /media/uploads/initiate { purpose: "kyc_document" } → presigned POST
 *   POST /media/uploads/confirm  → media row in 'ready' state
 *   POST /kyc/me/submissions     → bind ready media rows into a submission
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/kyc.service.js";

const docSchema = z.object({
  document_type: z.enum(["passport_ua", "passport_foreign", "id_card", "rnokpp", "fop_certificate", "selfie"]),
  media_id: z.string().uuid(),
  document_number: z.string().min(1).max(50).optional(),
  document_expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const submitSchema = z.object({
  documents: z.array(docSchema).min(1).max(10),
});

const rejectSchema = z.object({
  rejection_code: z.enum([
    "document_expired",
    "document_unreadable",
    "document_mismatch",
    "selfie_mismatch",
    "data_inconsistency",
    "unsupported_document_type",
    "incomplete_submission",
    "fraud_suspicion",
    "other",
  ]),
  rejection_note: z.string().max(1000).optional(),
});

async function requireAdmin(userId: string): Promise<boolean> {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.user_id, userId));
  return rows.some((r) => r.role === "admin" || r.role === "moderator");
}

export const kycRoutes: FastifyPluginAsync = async (server) => {
  /* ----------------------------- provider -------------------------------- */

  server.get(
    "/kyc/me",
    { preHandler: server.authenticate },
    async (req) => svc.getMine(req.auth!.user_id)
  );

  server.post(
    "/kyc/me/submissions",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          fields: parsed.error.flatten().fieldErrors,
        });
      }
      const r = await svc.submitKyc({
        provider_id: req.auth!.user_id,
        documents: parsed.data.documents,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  /* ------------------------------ admin --------------------------------- */

  server.get(
    "/admin/kyc",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
        .parse(req.query ?? {});
      return svc.listAdminQueue(q);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/kyc/:id/claim",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const r = await svc.claim({ kyc_id: req.params.id, admin_id: req.auth!.user_id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/kyc/:id/approve",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const r = await svc.approve({ kyc_id: req.params.id, admin_id: req.auth!.user_id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/kyc/:id/reject",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const parsed = rejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.reject({
        kyc_id: req.params.id,
        admin_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );
};
