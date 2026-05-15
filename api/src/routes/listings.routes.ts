/**
 * Module 5 §4.5 — listing REST endpoints (MVP cut).
 *
 * Drafts (wizard autosave) live in listing-drafts.service; listings in
 * listings.service. Admin moderation, reports, appeals — not yet wired.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as draftsSvc from "../services/listing-drafts.service.js";
import * as svc from "../services/listings.service.js";

/**
 * Allowlist for wizard-autosave payload. Free-form `unknown` rejected — every
 * key tied to a CreateListingInput field. `null` permitted to model the
 * "user cleared this input" state per FE contract (web/src/lib/listings.ts).
 */
const draftPayloadSchema = z
  .object({
    title: z.string().max(120).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    category_id: z.string().uuid().nullable().optional(),
    category_path: z
      .object({
        l1: z.object({ id: z.string(), name: z.string() }).partial().optional(),
        l2: z.object({ id: z.string(), name: z.string() }).partial().optional(),
        l3: z.object({ id: z.string(), name: z.string() }).partial().optional(),
      })
      .nullable()
      .optional(),
    city: z.string().max(80).nullable().optional(),
    region: z.string().max(80).nullable().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    pricing_type: z.enum(["fixed", "hourly", "range", "starting_from", "discuss", "visit", "hour", "project", "from"]).optional(),
    price_amount_kopecks: z.number().int().nullable().optional(),
    price_amount: z.number().int().nullable().optional(),
    price_amount_max: z.number().int().nullable().optional(),
    escrow_deposit: z.boolean().optional(),
    response_sla_minutes: z.number().int().optional(),
    gallery_media_ids: z.array(z.string().max(200)).max(10).optional(),
    cover_media_id: z.string().max(200).nullable().optional(),
    cover_url: z.string().max(2000).nullable().optional(),
    gallery_urls: z.array(z.string().max(2000)).max(10).optional(),
  })
  .strict();

const createSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(20).max(5000),
  category_id: z.string().uuid(),
  pricing_type: z.enum(["fixed", "hourly", "range", "starting_from", "discuss"]),
  price_amount: z.number().int().positive().nullable().optional(),
  price_amount_max: z.number().int().positive().nullable().optional(),
  service_type: z.enum(["on_site", "remote", "both"]).optional(),
  city: z.string().max(80).nullable().optional(),
  region: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  cover_url: z.string().max(2000).nullable().optional(),
  gallery_urls: z.array(z.string().max(2000)).max(10).optional(),
  response_sla_minutes: z.number().int().positive().nullable().optional(),
  draft_id: z.string().uuid().nullable().optional(),
});

const patchSchema = createSchema.partial().omit({ draft_id: true });

const queryListPublic = z.object({
  q: z.string().max(200).optional(),
  category_id: z.string().uuid().optional(),
  city: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const queryListMe = z.object({
  status: z.enum(["draft", "in_review", "active", "paused", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const listingsRoutes: FastifyPluginAsync = async (server) => {
  /* ------------------------------ drafts ------------------------------- */

  server.post(
    "/listings/drafts",
    { preHandler: server.authenticate },
    async (req) => {
      return await draftsSvc.createDraft(req.auth!.user_id);
    }
  );

  server.get(
    "/listings/drafts",
    { preHandler: server.authenticate },
    async (req) => {
      const items = await draftsSvc.listDrafts(req.auth!.user_id);
      return { items };
    }
  );

  server.get<{ Params: { id: string } }>(
    "/listings/drafts/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await draftsSvc.getDraft(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.status).send({ error: r.code });
      return r.value;
    }
  );

  server.patch<{ Params: { id: string } }>(
    "/listings/drafts/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = draftPayloadSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await draftsSvc.patchDraft(req.auth!.user_id, req.params.id, parsed.data);
      if (!r.ok) return reply.code(r.status).send({ error: r.code });
      return r.value;
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/listings/drafts/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await draftsSvc.deleteDraftById(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.status).send({ error: r.code });
      return reply.code(204).send();
    }
  );

  /* ----------------------------- listings ------------------------------ */

  server.post(
    "/listings",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          fields: parsed.error.flatten().fieldErrors,
        });
      }
      const r = await svc.createListing({ provider_id: req.auth!.user_id, ...parsed.data });
      if (!r.ok) {
        return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      }
      const detail = await svc.projectListing(r.value.id);
      return reply.code(201).send(detail);
    }
  );

  server.get(
    "/listings",
    async (req, reply) => {
      const q = queryListPublic.parse(req.query ?? {});
      const r = await svc.listPublic(q);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.get(
    "/listings/me",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const q = queryListMe.parse(req.query ?? {});
      const r = await svc.listOwn(req.auth!.user_id, q);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      return r.value;
    }
  );

  server.get<{ Params: { id: string } }>(
    "/listings/:id",
    async (req, reply) => {
      // Optional auth — anonymous gets active-only.
      let viewerId: string | null = null;
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        try {
          await server.authenticate(req);
          viewerId = req.auth?.user_id ?? null;
        } catch {}
      }
      const r = await svc.getListing(req.params.id, viewerId);
      if (r === null) return reply.code(404).send({ error: "listing_not_found" });
      if (r === "forbidden") return reply.code(404).send({ error: "listing_not_found" });
      return r;
    }
  );

  server.patch<{ Params: { id: string } }>(
    "/listings/:id",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          fields: parsed.error.flatten().fieldErrors,
        });
      }
      const r = await svc.editListing(req.auth!.user_id, req.params.id, parsed.data);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
      const detail = await svc.projectListing(req.params.id);
      return detail;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/listings/:id/publish",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.publishListing(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  server.post<{ Params: { id: string } }>(
    "/listings/:id/pause",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.pauseListing(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );

  // Module 5 REQ-006 — abuse report.
  const reportSchema = z.object({
    reason: z.enum(["spam", "fraud", "illegal_content", "misleading", "duplicate", "other"]),
    description: z.string().max(1000).optional(),
  });
  server.post<{ Params: { id: string } }>(
    "/listings/:id/reports",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const parsed = reportSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const r = await svc.reportListing({
        listing_id: req.params.id,
        reporter_id: req.auth!.user_id,
        reason: parsed.data.reason,
        description: parsed.data.description,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  // Module 5 REQ-007 — provider appeals report_threshold auto-pause.
  server.post<{ Params: { id: string } }>(
    "/listings/:id/appeal-pause",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.appealPause({
        listing_id: req.params.id,
        provider_id: req.auth!.user_id,
      });
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return reply.code(201).send(r.value);
    }
  );

  server.post<{ Params: { id: string } }>(
    "/listings/:id/archive",
    { preHandler: server.authenticate },
    async (req, reply) => {
      const r = await svc.archiveListing(req.auth!.user_id, req.params.id);
      if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code, ...(r.error.details ?? {}) });
      return r.value;
    }
  );
};
