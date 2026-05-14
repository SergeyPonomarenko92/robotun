/**
 * Module 1 §4 routes — register / login / refresh / logout.
 *
 * Body validation via zod; envelope mirrors the FE mock so the swap is
 * a config flip (NEXT_PUBLIC_API_BASE → http://localhost:4000/api/v1).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as auth from "../services/auth.service.js";

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const registerSchema = credentialsSchema.extend({
  initial_role: z.enum(["client", "provider"]).default("client"),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1).max(512),
});

function meta(req: { headers: Record<string, string | string[] | undefined>; ip?: string }) {
  const ua = req.headers["user-agent"];
  return {
    user_agent: typeof ua === "string" ? ua.slice(0, 512) : null,
    ip: req.ip ?? null,
  };
}

export const authRoutes: FastifyPluginAsync = async (server) => {
  server.post("/auth/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const r = await auth.register({
      ...parsed.data,
      ...meta(req),
    });
    if (!r.ok) {
      if (r.error.code === "email_taken") {
        return reply.code(409).send({ error: "email_taken" });
      }
      if (r.error.code === "weak_password") {
        return reply.code(400).send({
          error: "validation_failed",
          fields: { password: "too_short" },
        });
      }
    } else {
      return reply.code(201).send(r.result);
    }
  });

  server.post("/auth/login", async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const r = await auth.login({
      ...parsed.data,
      ...meta(req),
    });
    if (!r.ok) {
      if (r.error.code === "account_disabled") {
        return reply.code(403).send({ error: "account_disabled" });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return reply.code(200).send(r.result);
  });

  server.post("/auth/refresh", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const r = await auth.refresh(parsed.data.refresh_token, meta(req));
    if (!r.ok) {
      if (r.error.code === "user_disabled") {
        return reply.code(403).send({ error: "account_disabled" });
      }
      return reply.code(401).send({ error: "invalid_refresh" });
    }
    return reply.code(200).send(r.result);
  });

  server.post("/auth/logout", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      // Idempotent: missing/invalid body is still a 204 — caller drops the
      // token regardless.
      return reply.code(204).send();
    }
    await auth.logout(parsed.data.refresh_token);
    return reply.code(204).send();
  });
};

export const usersRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/users/me",
    { preHandler: server.authenticate },
    async (req) => {
      const u = req.auth!;
      return {
        id: u.user_id,
        email: u.email,
        display_name: u.display_name,
        has_provider_role: u.has_provider_role,
        kyc_status: u.kyc_status,
        payout_enabled: u.payout_enabled,
        mfa_enrolled: u.mfa_enrolled,
        status: u.status,
      };
    }
  );
};
