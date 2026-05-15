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
  // 6-digit TOTP OR 10-char A-Z0-9 backup code; service branches on shape.
  totp_code: z.string().regex(/^(\d{6}|[A-Z0-9]{10})$/).optional(),
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
      void auth.logAuthEvent({
        user_id: r.result.user.id,
        event_type: "login_success",
        ...meta(req),
        metadata: { via: "register" },
      });
      return reply.code(201).send(r.result);
    }
  });

  server.post("/auth/login", async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const m = meta(req);
    const r = await auth.login({
      ...parsed.data,
      ...m,
    });
    if (!r.ok) {
      void auth.logAuthEvent({
        user_id: null,
        event_type: "login_failure",
        ip: m.ip,
        user_agent: m.user_agent,
        metadata: { email: parsed.data.email, reason: r.error.code },
      });
      if (r.error.code === "account_disabled") {
        return reply.code(403).send({ error: "account_disabled" });
      }
      // mfa_required is a non-error continuation — 401 with the specific
      // code so the FE shows the second-factor prompt instead of "wrong
      // password". invalid_mfa_code also 401 to avoid leaking whether
      // password was right but code wrong vs password wrong.
      if (r.error.code === "mfa_required" || r.error.code === "invalid_mfa_code") {
        return reply.code(401).send({ error: r.error.code });
      }
      if (r.error.code === "too_many_attempts") {
        reply.header("Retry-After", String(r.error.retry_after_seconds));
        return reply.code(429).send({
          error: "too_many_attempts",
          retry_after_seconds: r.error.retry_after_seconds,
        });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    void auth.logAuthEvent({
      user_id: r.result.user.id,
      event_type: "login_success",
      ip: m.ip,
      user_agent: m.user_agent,
    });
    return reply.code(200).send(r.result);
  });

  server.post("/auth/refresh", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const m = meta(req);
    const r = await auth.refresh(parsed.data.refresh_token, m);
    if (!r.ok) {
      if (r.error.code === "user_disabled") {
        return reply.code(403).send({ error: "account_disabled" });
      }
      return reply.code(401).send({ error: "invalid_refresh" });
    }
    void auth.logAuthEvent({
      user_id: r.result.user.id,
      event_type: "refresh",
      ip: m.ip,
      user_agent: m.user_agent,
    });
    return reply.code(200).send(r.result);
  });

  server.post("/auth/logout", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      // Idempotent: missing/invalid body is still a 204 — caller drops the
      // token regardless.
      return reply.code(204).send();
    }
    const lr = await auth.logout(parsed.data.refresh_token);
    void auth.logAuthEvent({
      user_id: lr.user_id,
      event_type: "logout",
      ...meta(req),
    });
    return reply.code(204).send();
  });

  // Forgot-password — always 204 regardless of whether email exists,
  // to avoid an enumeration oracle. Real send happens fire-and-forget
  // server-side.
  const forgotSchema = z.object({ email: z.string().email().max(254) });
  server.post("/auth/forgot-password", async (req, reply) => {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const fr = await auth.requestPasswordReset({
      email: parsed.data.email,
      ip: req.ip,
      user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
    // Audit row written regardless of email existence — anti-enumeration
    // preserved at the HTTP surface (always 204); audit metadata.email
    // records the attempt for ops review. user_id is the real user when
    // matched, NULL when unknown.
    void auth.logAuthEvent({
      user_id: fr.user_id,
      event_type: "password_reset_requested",
      ...meta(req),
      metadata: { email: parsed.data.email, matched: fr.user_id !== null },
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
    void auth.logAuthEvent({
      user_id: r.value.user_id,
      event_type: "password_reset_completed",
      ...meta(req),
    });
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
      void auth.logAuthEvent({
        user_id: req.auth!.user_id,
        event_type: "email_verification_requested",
        ...meta(req),
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
    void auth.logAuthEvent({
      user_id: r.value.user_id,
      event_type: "email_verified",
      ...meta(req),
      metadata: { email: r.value.email },
    });
    return { email: r.value.email };
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
      // Only audit when something actually changed (Object.keys non-empty
      // in parsed.data). Empty-body read-back doesn't deserve a row.
      if (parsed.data.display_name !== undefined || parsed.data.avatar_media_id !== undefined) {
        void auth.logAuthEvent({
          user_id: req.auth!.user_id,
          event_type: "profile_updated",
          ...meta(req),
          metadata: {
            changed_display_name: parsed.data.display_name !== undefined,
            changed_avatar: parsed.data.avatar_media_id !== undefined,
          },
        });
      }
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
      void auth.logAuthEvent({
        user_id: req.auth!.user_id,
        event_type: "password_changed",
        ...meta(req),
      });
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
      void auth.logAuthEvent({
        user_id: req.auth!.user_id,
        event_type: "account_deleted",
        ...meta(req),
      });
      return reply.code(204).send();
    }
  );

  // TOTP MFA — enroll / verify / disable. v1 single-factor (TOTP only,
  // no recovery codes); v2 adds backup codes + webauthn.
  server.post(
    "/me/mfa/totp/enroll",
    { preHandler: server.authenticate },
    async (req) => auth.enrollTotp({ user_id: req.auth!.user_id })
  );

  const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
  server.post(
    "/me/mfa/totp/verify",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = totpCodeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await auth.verifyTotp({ user_id: req.auth!.user_id, code: parsed.data.code });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  const disableTotpSchema = z.object({
    password: z.string().min(1).max(256),
    code: z.string().regex(/^\d{6}$/),
  });
  // Generate/regenerate 10 single-use recovery codes. Plaintexts shown
  // ONCE in the response — FE must persuade the user to save them.
  // Calling again invalidates all prior codes.
  server.post(
    "/me/mfa/totp/recovery-codes",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await auth.generateRecoveryCodes({ user_id: req.auth!.user_id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.post(
    "/me/mfa/totp/disable",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = disableTotpSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await auth.disableTotp({ user_id: req.auth!.user_id, ...parsed.data });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(204).send();
    }
  );

  // Email change — two-step. Step 1: user submits password + new email,
  // server sends verification link to the NEW address. Step 2: clicking
  // the link calls /auth/confirm-email-change with the token; only then
  // does users.email flip. Both endpoints idempotent; old email keeps
  // working until step 2 commits.
  const reqEmailChangeSchema = z.object({
    password: z.string().min(1).max(256),
    new_email: z.string().email().max(254),
  });
  server.post(
    "/me/email/change",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = reqEmailChangeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await auth.requestEmailChange({
        user_id: req.auth!.user_id,
        password: parsed.data.password,
        new_email: parsed.data.new_email,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      void auth.logAuthEvent({
        user_id: req.auth!.user_id,
        event_type: "email_change_requested",
        ...meta(req),
        metadata: { new_email: parsed.data.new_email },
      });
      return reply.code(204).send();
    }
  );

  const confirmEmailChangeSchema = z.object({ token: z.string().min(8).max(128) });
  server.post("/auth/confirm-email-change", async (req, reply) => {
    const parsed = confirmEmailChangeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const r = await auth.confirmEmailChange(parsed.data);
    if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
    void auth.logAuthEvent({
      user_id: r.value.user_id,
      event_type: "email_changed",
      ...meta(req),
      metadata: { new_email: r.value.new_email },
    });
    return r.value;
  });

  // GDPR Art.20 right-to-data-portability. Synchronous JSON snapshot of
  // the user's data across modules. Reply has Content-Disposition so the
  // browser can save-as.
  server.get(
    "/me/data-export",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const data = await auth.exportUserData(req.auth!.user_id);
      if (!data) return reply.code(404).send({ error: "user_not_found" });
      reply.header(
        "Content-Disposition",
        `attachment; filename="robotun-data-${req.auth!.user_id}.json"`
      );
      return data;
    }
  );

  // Own audit trail. Cursor pagination on the bigserial id, 100/page max.
  const audSchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  });
  server.get(
    "/me/audit",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = audSchema.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      const r = await auth.listAuthAudit({ user_id: req.auth!.user_id, ...parsed.data });
      if ("error" in r) return reply.code(400).send({ error: r.error });
      return r;
    }
  );
};

export const usersRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/users/me",
    { preHandler: server.authenticate },
    async (req) => auth.getCurrentUserProfile(req.auth!.user_id)
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
    async (req) => {
      const r = await auth.revokeAllSessions(req.auth!.user_id);
      void auth.logAuthEvent({
        user_id: req.auth!.user_id,
        event_type: "sessions_logged_out_all",
        ...meta(req),
        metadata: { revoked: r.revoked },
      });
      return r;
    }
  );
};
