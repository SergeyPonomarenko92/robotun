/**
 * Module 13 §4 — minimal search surface. The full FTS-ranked impl with
 * provider_quality_score, facet aggregation, and HMAC-signed cursors is
 * descoped MVP; this thin wrapper enforces REQ-001 / REQ-005 / REQ-006 /
 * REQ-007 so the FE contract is testable end-to-end and the route name
 * is reserved in the URL space.
 *
 *   - REQ-001: `q` required, 400 query_required otherwise.
 *   - REQ-006: `q` length cap 200, 400 query_too_long otherwise.
 *   - REQ-007: default page_size 20, max 50.
 *   - REQ-005: pagination depth cap 5 pages — soft enforce via cursor
 *     hop counter encoded in the cursor; rejecting depth > 5 with
 *     400 pagination_depth_exceeded.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as svc from "../services/listings.service.js";

const MAX_QUERY_LEN = 200;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 5;

const searchSchema = z.object({
  q: z.string().min(1, "query_required").max(MAX_QUERY_LEN, "query_too_long"),
  category_id: z.string().uuid().optional(),
  city: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(2000).optional(),
});

function decodeDepth(cursor?: string): number {
  if (!cursor) return 1;
  // Cursor format from listings.listPublic is opaque; we tag it with a
  // page-depth prefix here so REQ-005 can be enforced without rewriting
  // the underlying cursor format.
  const m = cursor.match(/^p(\d+)\./);
  return m ? parseInt(m[1]!, 10) : 1;
}
function tagDepth(cursor: string | null, depth: number): string | null {
  if (!cursor) return null;
  return `p${depth + 1}.${cursor.replace(/^p\d+\./, "")}`;
}

export const searchRoutes: FastifyPluginAsync = async (server) => {
  server.get("/search/listings", async (req, reply) => {
    const parsed = searchSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      const err = parsed.error.flatten();
      const msg = err.fieldErrors.q?.[0];
      if (msg === "query_required") return reply.code(400).send({ error: "query_required" });
      if (msg === "query_too_long") return reply.code(400).send({ error: "query_too_long", max: MAX_QUERY_LEN });
      return reply.code(400).send({ error: "invalid_query" });
    }
    const incoming = parsed.data.cursor;
    const depth = decodeDepth(incoming);
    if (depth > MAX_PAGES) {
      return reply.code(400).send({ error: "pagination_depth_exceeded", max_pages: MAX_PAGES });
    }
    // Strip our depth tag before handing to the listings service.
    const innerCursor = incoming ? incoming.replace(/^p\d+\./, "") : undefined;
    const r = await svc.listPublic({
      q: parsed.data.q,
      category_id: parsed.data.category_id,
      city: parsed.data.city,
      limit: parsed.data.limit,
      cursor: innerCursor,
    });
    if (!r.ok) return reply.code(r.error.status).send({ error: r.error.code });
    return {
      ...r.value,
      next_cursor: tagDepth(r.value.next_cursor, depth),
    };
  });
};
