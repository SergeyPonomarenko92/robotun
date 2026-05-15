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

  // Forgot-password — always 204 regardless of whether email exists,
  // to avoid an enumeration oracle. Real send happens fire-and-forget
  // server-side.
  const forgotSchema = z.object({ email: z.string().email().max(254) });
  server.post("/auth/forgot-password", async (req, reply) => {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    await auth.requestPasswordReset({
      email: parsed.data.email,
      ip: req.ip,
      user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
    return reply.code(204).send();
  });

  const resetSchema = z.object({
    token: z.string().min(8).max(128),
    new_password: z.string().min(12).max(256),
  });
  server.post("/auth/reset-password", async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const r = await auth.resetPassword(parsed.data);
    if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
    return { ok: true };
  });

  // Email verification — current user requests a fresh token. Always 204
  // (no enumeration concern since this is auth'd, but consistent with
  // /auth/forgot-password).
  server.post(
    "/auth/request-email-verification",
    { preHandler: server.authenticate },
    async (req, reply) => {
      await auth.requestEmailVerification({
        user_id: req.auth!.user_id,
        email: req.auth!.email,
      });
      return reply.code(204).send();
    }
  );

  const verifyEmailSchema = z.object({ token: z.string().min(8).max(128) });
  server.post("/auth/verify-email", async (req, reply) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const r = await auth.verifyEmail(parsed.data.token);
    if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
    return r.value;
  });

  // Profile update — partial. Either or both fields optional; empty
  // body is a read-back (no-op + returns current state).
  const profileSchema = z.object({
    display_name: z.string().min(2).max(80).optional(),
    avatar_media_id: z.string().uuid().optional(),
  });
  server.patch(
    "/me/profile",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = profileSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await auth.updateProfile({
        user_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  // Password change — authenticated. Old password required for re-auth;
  // new password obeys the same 12-char floor as register. All sessions
  // revoked + ver bumped on success (FE must refresh).
  const changePwdSchema = z.object({
    old_password: z.string().min(1).max(256),
    new_password: z.string().min(12).max(256),
  });
  server.post(
    "/me/password",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = changePwdSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await auth.changePassword({
        user_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(204).send();
    }
  );

  // Account deletion (GDPR Art.17). Requires password re-auth + the
  // literal string "DELETE" as confirmation to prevent CSRF/double-click
  // accidents. Anonymises the user record (does not DROP — FKs in
  // deals/reviews/messages stay valid). FE redirects to / on 204.
  const deleteSchema = z.object({
    password: z.string().min(1).max(256),
    confirmation: z.literal("DELETE"),
  });
  server.post(
    "/me/account/delete",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = deleteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await auth.deleteAccount({
        user_id: req.auth!.user_id,
        password: parsed.data.password,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(204).send();
    }
  );
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

  // Active sessions for the current user. Refresh-token hashes are never
  // surfaced; FE renders { id, user_agent, ip, created_at, expires_at }.
  server.get(
    "/me/sessions",
    { preHandler: server.authenticate },
    async (req) => auth.listActiveSessions(req.auth!.user_id)
  );

  // Post-breach reset — revoke all active refresh sessions AND bump
  // users.ver so existing access tokens fail at the next request (the
  // authenticate plugin re-reads ver each call). Note: caller's own
  // session is revoked too; FE must immediately redirect to login.
  server.post(
    "/me/sessions/logout-all",
    { preHandler: server.authenticate },
    async (req) => auth.revokeAllSessions(req.auth!.user_id)
  );
};
