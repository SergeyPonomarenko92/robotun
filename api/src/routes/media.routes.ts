/**
 * Module 6 §4.5 — media REST endpoints (MVP cut).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/media.service.js";
import * as lm from "../services/listing-media.service.js";

const initiateSchema = z.object({
  purpose: z.enum(["listing_cover", "listing_gallery", "avatar", "kyc_document"]),
  listing_id: z.string().uuid().optional(),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
  byte_size: z.number().int().positive().max(20 * 1024 * 1024),
  original_filename: z.string().max(255).optional(),
});

const confirmSchema = z.object({
  media_id: z.string().uuid(),
  checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const attachSchema = z.object({
  media_id: z.string().uuid(),
  display_order: z.number().int().min(0).max(99).optional(),
});

export const mediaRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/media/uploads/initiate",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = initiateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", fields: parsed.error.flatten().fieldErrors });
      }
      const r = await svc.initiateUpload({
        user_id: req.auth!.user_id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  server.post(
    "/media/uploads/confirm",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.confirmUpload({ user_id: req.auth!.user_id, ...parsed.data });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(202).send(r.value);
    }
  );

  server.get<{ Params: { id: string } }>(
    "/media/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.getMetadata({ user_id: req.auth!.user_id, media_id: req.params.id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.get<{ Params: { id: string }; Querystring: { variant?: string } }>(
    "/media/:id/stream",
    async (req, reply) => {
      let viewerId: string | null = null;
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        try {
          await server.authenticate(req);
          viewerId = req.auth?.user_id ?? null;
        } catch {}
      }
      const r = await svc.getStreamUrl({
        user_id: viewerId,
        media_id: req.params.id,
        variant: req.query.variant ?? null,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.redirect(r.value.url, 302);
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/media/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.softDelete({ user_id: req.auth!.user_id, media_id: req.params.id });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(204).send();
    }
  );

  server.get(
    "/media",
    { preHandler: server.authenticate },
    async (req) => {
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
        .parse(req.query ?? {});
      return svc.listOwnMedia(req.auth!.user_id, q);
    }
  );

  /* ----------------- listing↔media link (Module 5 bridge) ----------------- */

  server.post<{ Params: { id: string } }>(
    "/listings/:id/media",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = attachSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await lm.attach({
        user_id: req.auth!.user_id,
        listing_id: req.params.id,
        ...parsed.data,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  server.delete<{ Params: { id: string; media_id: string } }>(
    "/listings/:id/media/:media_id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await lm.detach({
        user_id: req.auth!.user_id,
        listing_id: req.params.id,
        media_id: req.params.media_id,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return reply.code(204).send();
    }
  );
};
