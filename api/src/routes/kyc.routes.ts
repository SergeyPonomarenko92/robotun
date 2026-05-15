/**
 * Module 4 §4.8 — KYC REST endpoints (MVP cut).
 *
 * Document upload uses Module 6 Media pipeline directly:
 *   POST /media/uploads/initiate { purpose: "kyc_document" } → presigned POST
 *   POST /media/uploads/confirm  → media row in 'ready' state
 *   POST /kyc/me/submissions     → bind ready media rows into a submission
 */
import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Readable } from "node:stream";
import { db } from "../db/client.js";
import { userRoles, users } from "../db/schema.js";
import * as svc from "../services/kyc.service.js";
import { streamObject } from "../services/s3.js";

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
  // RISK-4 (SEC-006 from KYC spec, cross-ref Auth SEC-006): JOIN users +
  // gate on users.status='active' so a suspended admin whose JWT is still
  // live (≤15-min window) cannot pass the role check. Re-reads against
  // primary DB on every call (no replica fallback).
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.user_id))
    .where(and(eq(userRoles.user_id, userId), eq(users.status, "active")));
  return rows.some((r) => r.role === "admin" || r.role === "moderator");
}

// Spec §4.2 — KYC is provider-only. The mock route already enforces this;
// real BE was creating orphan kyc_verifications rows for client logins via
// ensureKycRow on GET /kyc/me.
async function requireProvider(userId: string): Promise<boolean> {
  const rows = await db
    .select({ has_provider_role: users.has_provider_role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.has_provider_role === true;
}

export const kycRoutes: FastifyPluginAsync = async (server) => {
  /* ----------------------------- provider -------------------------------- */

  server.get(
    "/kyc/me",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireProvider(req.auth!.user_id))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      return svc.getMine(req.auth!.user_id);
    }
  );

  server.post(
    "/kyc/me/submissions",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireProvider(req.auth!.user_id))) {
        return reply.code(403).send({ error: "forbidden" });
      }
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
        audit: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
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
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          status: z.enum(["open", "approved", "rejected", "expired"]).default("open"),
        })
        .parse(req.query ?? {});
      return svc.listAdminQueue(q);
    }
  );

  // FE-canonical provider-id-keyed routes (delegate to id-keyed handlers).
  server.post<{ Params: { provider_id: string } }>(
    "/admin/kyc/:provider_id/approve",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const kycId = await svc.kycIdForProvider(req.params.provider_id);
      if (!kycId) return reply.code(404).send({ error: "not_found" });
      const audit = { ip: req.ip, user_agent: req.headers["user-agent"] ?? null };
      // Auto-claim if not claimed yet (FE flow doesn't separate claim+approve).
      const claimR = await svc.claim({ kyc_id: kycId, admin_id: req.auth!.user_id, audit });
      if (!claimR.ok && claimR.error.code !== "not_claimable") {
        return reply.code(claimR.error.status).send({ error: claimR.error.code });
      }
      const r = await svc.approve({ kyc_id: kycId, admin_id: req.auth!.user_id, audit });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  server.post<{ Params: { provider_id: string } }>(
    "/admin/kyc/:provider_id/reject",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const kycId = await svc.kycIdForProvider(req.params.provider_id);
      if (!kycId) return reply.code(404).send({ error: "not_found" });
      const parsed = rejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const audit = { ip: req.ip, user_agent: req.headers["user-agent"] ?? null };
      const claimR = await svc.claim({ kyc_id: kycId, admin_id: req.auth!.user_id, audit });
      if (!claimR.ok && claimR.error.code !== "not_claimable") {
        return reply.code(claimR.error.status).send({ error: claimR.error.code });
      }
      const r = await svc.reject({ kyc_id: kycId, admin_id: req.auth!.user_id, audit, ...parsed.data });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  // REQ-011 — admin force-rekyc. Sets payout_enabled=false immediately,
  // flips kyc state to not_submitted, emits kyc.rekyc_required.
  const flagRekycSchema = z.object({ reason: z.string().min(5).max(500) });
  server.post<{ Params: { provider_id: string } }>(
    "/admin/kyc/:provider_id/flag-rekyc",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const parsed = flagRekycSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.flagRekyc({
        provider_id: req.params.provider_id,
        admin_id: req.auth!.user_id,
        reason: parsed.data.reason,
        audit: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  /* --------- REQ-013 streaming proxy — provider self + admin ---------- */
  // Bytes flow Fastify → client; no signed URL ever reaches the wire.
  // 60s idle timeout via socket.setTimeout. Back-pressure handled by
  // Readable.from(asyncIterable, {objectMode:false}).pipe(reply.raw).
  //
  // Audit policy (critic RISK-d):
  //   - Admin reads → row in kyc_review_events event_type='document_accessed'.
  //   - Provider self-reads → intentionally UNAUDITED. Provider reading
  //     their own KYC documents is not a privacy event; only third-party
  //     (admin) access is subject to forensic reconstruction.
  //   - Audit row commits BEFORE the S3 GetObject call. If S3 fails after
  //     commit, the audit row exists for a read that produced 0 bytes —
  //     accepted false-positive (admin-access intent was real).
  async function streamHandler(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    resolved: { bucket: "kyc-private"; key: string; mime_type: string; document_id: string }
  ) {
    const { body, contentLength } = await streamObject({
      bucket: resolved.bucket,
      key: resolved.key,
    });
    reply.header("content-type", resolved.mime_type);
    // critic RISK-c: force-download. Prevents browser inline rendering of
    // PII (passport scans / RNOKPP / selfies) and removes the "right-click
    // → copy URL" vector. Filename obfuscated — actor sees the document_id.
    reply.header("content-disposition", `attachment; filename="kyc-${resolved.document_id}"`);
    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    if (contentLength != null) reply.header("content-length", String(contentLength));
    // 60s socket timeout per spec §4.8 row "stream".
    req.raw.setTimeout(60_000);
    // critic RISK-b: objectMode:false so the Readable accounts highWaterMark
    // in bytes (default 16KB) rather than objects (default 16). On a 10MB
    // KYC scan this caps the in-flight buffer to a few chunks instead of
    // ~160 — restores AC-017 "≤64KB buffer" intent.
    return reply.send(
      Readable.from(body as AsyncIterable<Uint8Array>, { objectMode: false })
    );
  }

  server.get<{ Params: { id: string } }>(
    "/kyc/me/documents/:id/stream",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.resolveStreamableDocument({
        document_id: req.params.id,
        actor_id: req.auth!.user_id,
        actor_role: "provider",
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return streamHandler(req, reply, r.value);
    }
  );

  server.get<{ Params: { provider_id: string; id: string } }>(
    "/admin/kyc/:provider_id/documents/:id/stream",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const r = await svc.resolveStreamableDocument({
        document_id: req.params.id,
        actor_id: req.auth!.user_id,
        actor_role: "admin",
        audit: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      // Spec §4.8 admin route is keyed by provider_id; cross-check the
      // document actually belongs to this provider (URL param vs row).
      if (r.value.provider_id !== req.params.provider_id) {
        return reply.code(404).send({ error: "not_found" });
      }
      return streamHandler(req, reply, r.value);
    }
  );

  // REQ-006 / §4.5 admin suspend (approved → rejected + kyc.suspended).
  const suspendSchema = z.object({
    reason_code: z.enum(svc.SUSPEND_REASON_CODES_PUBLIC as unknown as [string, ...string[]]),
    reason_note: z.string().min(5).max(1000),
  });
  server.post<{ Params: { provider_id: string } }>(
    "/admin/kyc/:provider_id/suspend",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const parsed = suspendSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.suspendApproval({
        provider_id: req.params.provider_id,
        admin_id: req.auth!.user_id,
        reason_code: parsed.data.reason_code,
        reason_note: parsed.data.reason_note,
        audit: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  // REQ-012 §4.8.4 — admin bumps submission_limit by 5 (cap 20). Reason
  // code enum sourced from kyc.service.ts (single source of truth).
  const unblockSchema = z.object({
    reason_code: z.enum(svc.UNBLOCK_REASON_CODES as unknown as [string, ...string[]]),
    reason_note: z.string().max(1000).optional(),
  });
  server.post<{ Params: { provider_id: string } }>(
    "/admin/kyc/:provider_id/unblock",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const parsed = unblockSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.unblockSubmissionLimit({
        provider_id: req.params.provider_id,
        admin_id: req.auth!.user_id,
        reason_code: parsed.data.reason_code,
        reason_note: parsed.data.reason_note,
        audit: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  // Legacy id-keyed claim path retained for internal/admin tooling that
  // tracks by kyc_id. /approve and /reject are FE-canonical provider-id-
  // keyed (above) and auto-claim internally.
  server.post<{ Params: { provider_id: string } }>(
    "/admin/kyc/:provider_id/claim",
    { preHandler: server.authenticate },
    async (req, reply) => {
      if (!(await requireAdmin(req.auth!.user_id))) return reply.code(403).send({ error: "forbidden" });
      const kycId = await svc.kycIdForProvider(req.params.provider_id);
      if (!kycId) return reply.code(404).send({ error: "not_found" });
      const r = await svc.claim({
        kyc_id: kycId,
        admin_id: req.auth!.user_id,
        audit: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );
};
