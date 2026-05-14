import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { userRoles } from "../db/schema.js";
import * as svc from "../services/admin.service.js";

async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!req.auth) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  const r = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, req.auth.user_id));
  const ok = r.some((x) => x.role === "admin" || x.role === "moderator");
  if (!ok) {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

const suspendSchema = z.object({ reason: z.string().min(1).max(1000) });

export const adminRoutes: FastifyPluginAsync = async (server) => {
  server.get("/admin/queue", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query ?? {});
    return svc.unifiedQueue(q);
  });

  server.get("/admin/stats", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return svc.platformStats();
  });

  server.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const r = await svc.userDetail(req.params.id);
      if (!r) return reply.code(404).send({ error: "user_not_found" });
      return r;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/users/:id/suspend",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const parsed = suspendSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.suspendUser({
        admin_id: req.auth!.user_id,
        target_user_id: req.params.id,
        reason: parsed.data.reason,
        ip: req.ip,
        ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/admin/users/:id/activate",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const r = await svc.activateUser({
        admin_id: req.auth!.user_id,
        target_user_id: req.params.id,
        ip: req.ip,
        ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.get("/admin/actions", { preHandler: server.authenticate }, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        actor_id: z.string().uuid().optional(),
        target_user_id: z.string().uuid().optional(),
      })
      .parse(req.query ?? {});
    return svc.listAdminActions(q);
  });
};
