/**
 * Module 10 §4.6 — category REST endpoints.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/categories.service.js";

async function hasAnyRole(userId: string, allow: ("admin" | "moderator")[]): Promise<boolean> {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.user_id, userId));
  return rows.some((r) => allow.includes(r.role as "admin" | "moderator"));
}

async function requireRole(
  req: FastifyRequest,
  reply: FastifyReply,
  allow: ("admin" | "moderator")[]
): Promise<boolean> {
  if (!req.auth) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  const ok = await hasAnyRole(req.auth.user_id, allow);
  if (!ok) {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

const proposeSchema = z.object({
  parent_category_id: z.string().uuid(),
  proposed_name: z.string().min(2).max(120),
});

const mineQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "auto_rejected", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const approveSchema = z.object({
  slug_override: z
    .string()
    .regex(/^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$/)
    .optional(),
  note: z.string().max(1000).optional(),
});

const rejectSchema = z.object({
  rejection_code: z.enum([
    "policy_violation",
    "admin_override",
    "duplicate_category",
    "parent_archived",
    "max_depth_exceeded",
  ]).default("policy_violation"),
  note: z.string().max(1000).optional(),
});

const adminCreateSchema = z.object({
  name: z.string().min(2).max(120),
  parent_id: z.string().uuid().nullable().default(null),
  slug_override: z
    .string()
    .regex(/^[a-z0-9][a-z0-9\-]{0,98}[a-z0-9]$/)
    .optional(),
});

const archiveSchema = z.object({ cascade: z.boolean().default(false) });

const editSchema = z.object({ name: z.string().min(2).max(120) });

const adminListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const categoriesRoutes: FastifyPluginAsync = async (server) => {
  // Public tree. `items` envelope matches FE mock contract (web/src/lib/categories.ts).
  server.get("/categories", async () => {
    const tree = await svc.getTree();
    return { items: tree };
  });

  server.get(
    "/categories/proposals/mine",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const q = mineQuerySchema.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      const r = await svc.listOwnProposals(req.auth!.user_id, q.data);
      return r;
    }
  );

  server.post(
    "/categories/proposals",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = proposeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", fields: parsed.error.flatten().fieldErrors });
      }
      const r = await svc.submitProposal({
        proposer_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(201).send(r.value);
    }
  );

  /* ------------------------------- admin ------------------------------- */

  server.get(
    "/admin/categories/proposals",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireRole(req, reply, ["admin", "moderator"]))) return;
      const q = adminListQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      return svc.listPendingProposals(q.data);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/categories/proposals/:id/approve",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireRole(req, reply, ["admin"]))) return;
      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.approveProposal({
        proposal_id: req.params.id,
        admin_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(200).send(r.value);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/categories/proposals/:id/reject",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireRole(req, reply, ["admin", "moderator"]))) return;
      const parsed = rejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.rejectProposal({
        proposal_id: req.params.id,
        actor_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(200).send(r.value);
    }
  );

  server.post(
    "/admin/categories",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireRole(req, reply, ["admin"]))) return;
      const parsed = adminCreateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.adminCreate({
        admin_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(201).send(r.value);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/categories/:id/archive",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireRole(req, reply, ["admin"]))) return;
      const parsed = archiveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.archiveCategory({
        category_id: req.params.id,
        admin_id: req.auth!.user_id,
        cascade: parsed.data.cascade,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, details: r.error.details });
      return reply.code(200).send(r.value);
    }
  );

  server.patch<{ Params: { id: string } }>(
    "/admin/categories/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireRole(req, reply, ["admin"]))) return;
      const parsed = editSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.editCategoryName({
        category_id: req.params.id,
        admin_id: req.auth!.user_id,
        name: parsed.data.name,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(200).send(r.value);
    }
  );
};
