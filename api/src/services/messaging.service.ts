/**
 * Module 2 — Messaging (MVP cut).
 *
 * Polling-based. SSE/Redis pub-sub, contact-info detection, moderation,
 * attachments — deferred.
 */
import { and, desc, eq, inArray, or, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  conversationReads,
  conversations,
  deals,
  listings,
  messages,
  outboxEvents,
} from "../db/schema.js";

type ServiceError = { code: string; status: number; details?: unknown };
type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };
const err = (code: string, status: number, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, status, details },
});

function pgCode(e: unknown): string | undefined {
  const o = e as { code?: string; cause?: { code?: string } };
  return o?.code ?? o?.cause?.code;
}

/* ---------------------- create / open conversation ----------------------- */

export async function openPreDealConversation(args: {
  user_id: string;
  listing_id: string;
}): Promise<Result<{ id: string; created: boolean }>> {
  const ls = await db
    .select({ provider_id: listings.provider_id, status: listings.status })
    .from(listings)
    .where(eq(listings.id, args.listing_id))
    .limit(1);
  if (ls.length === 0) return err("listing_not_found", 404);
  if (ls[0]!.status !== "active") return err("listing_not_active", 409);
  if (ls[0]!.provider_id === args.user_id) return err("self_conversation_forbidden", 422);
  const providerId = ls[0]!.provider_id;
  if (!providerId) return err("provider_missing", 422);

  // Idempotent: existing returns same id.
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.kind, "pre_deal"),
        eq(conversations.listing_id, args.listing_id),
        eq(conversations.client_id, args.user_id)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return { ok: true, value: { id: existing[0]!.id, created: false } };
  }

  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(conversations)
      .values({
        kind: "pre_deal",
        listing_id: args.listing_id,
        client_id: args.user_id,
        provider_id: providerId,
      })
      .returning({ id: conversations.id });
    const id = inserted[0]!.id;
    await tx.insert(outboxEvents).values({
      aggregate_type: "conversation",
      aggregate_id: id,
      event_type: "conversation.created",
      payload: { conversation_id: id, kind: "pre_deal", client_id: args.user_id, provider_id: providerId },
    });
    return { ok: true as const, value: { id, created: true } };
  }).catch(async (e) => {
    if (pgCode(e) === "23505") {
      // Lost the race — re-fetch the now-existing row so idempotency is
      // preserved (caller can resolve the conversation id either way).
      const existing = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.kind, "pre_deal"),
            eq(conversations.listing_id, args.listing_id),
            eq(conversations.client_id, args.user_id)
          )
        )
        .limit(1);
      if (existing.length > 0) return { ok: true as const, value: { id: existing[0]!.id, created: false } };
      return err("conversation_exists", 409);
    }
    throw e;
  });
}

/* ---------------------------- list / read -------------------------------- */

/** FE Conversation shape (web/src/lib/messaging.ts:14). */
type ConversationFE = {
  id: string;
  scope: "pre_deal" | "deal";
  listing_id: string | null;
  deal_id: string | null;
  status: "active" | "locked" | "archived";
  counterparty: { id: string; display_name: string; avatar_url?: string; kyc_verified: boolean } | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  blocked_by: string | null;
  created_at: string;
};

export async function listMine(userId: string) {
  const rows = await db.execute<{
    id: string;
    kind: string;
    listing_id: string | null;
    deal_id: string | null;
    status: string;
    last_message_at: Date | string | null;
    created_at: Date | string;
    cp_id: string | null;
    cp_name: string | null;
    cp_avatar: string | null;
    cp_kyc_at: Date | string | null;
    preview: string | null;
  }>(
    dsql`SELECT c.id, c.kind, c.listing_id, c.deal_id, c.status,
                c.last_message_at, c.created_at,
                cu.id AS cp_id, cu.display_name AS cp_name,
                cu.avatar_url AS cp_avatar, cu.kyc_approved_at AS cp_kyc_at,
                (SELECT body FROM messages m
                   WHERE m.conversation_id = c.id
                   ORDER BY m.created_at DESC LIMIT 1) AS preview
           FROM conversations c
           LEFT JOIN users cu ON cu.id =
             CASE WHEN c.client_id = ${userId} THEN c.provider_id ELSE c.client_id END
          WHERE c.client_id = ${userId} OR c.provider_id = ${userId}
          ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
          LIMIT 100`
  );
  if (rows.length === 0) return { items: [] as ConversationFE[] };

  const convIds = rows.map((r) => r.id);
  const counts = await db
    .select({
      conversation_id: messages.conversation_id,
      unread: dsql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .leftJoin(
      conversationReads,
      and(
        eq(conversationReads.conversation_id, messages.conversation_id),
        eq(conversationReads.user_id, userId)
      )
    )
    .where(
      and(
        inArray(messages.conversation_id, convIds),
        dsql`${messages.sender_id} <> ${userId}`,
        dsql`(${conversationReads.last_read_at} IS NULL OR ${messages.created_at} > ${conversationReads.last_read_at})`
      )
    )
    .groupBy(messages.conversation_id);
  const byConv = new Map(counts.map((c) => [c.conversation_id, c.unread]));

  const items: ConversationFE[] = rows.map((r) => ({
    id: r.id,
    scope: r.kind as "pre_deal" | "deal",
    listing_id: r.listing_id,
    deal_id: r.deal_id,
    status: (r.status === "open" ? "active" : r.status) as "active" | "locked" | "archived",
    counterparty: r.cp_id
      ? {
          id: r.cp_id,
          display_name: r.cp_name ?? "",
          avatar_url: r.cp_avatar ?? undefined,
          kyc_verified: r.cp_kyc_at != null,
        }
      : null,
    last_message_at: r.last_message_at
      ? typeof r.last_message_at === "string"
        ? new Date(r.last_message_at).toISOString()
        : r.last_message_at.toISOString()
      : null,
    last_message_preview: r.preview ? r.preview.slice(0, 200) : null,
    unread_count: byConv.get(r.id) ?? 0,
    blocked_by: null,
    created_at:
      typeof r.created_at === "string"
        ? new Date(r.created_at).toISOString()
        : r.created_at.toISOString(),
  }));
  return { items };
}

export async function getConversation(userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (rows.length === 0) return null;
  const c = rows[0]!;
  if (c.client_id !== userId && c.provider_id !== userId) return "forbidden" as const;
  return c;
}

function decodeMsgCursor(c: string): { t: string; i: string } | null {
  try {
    const o = JSON.parse(Buffer.from(c, "base64").toString("utf8"));
    if (typeof o?.t === "string" && typeof o?.i === "string" && !isNaN(Date.parse(o.t))) return o;
  } catch {}
  return null;
}

export async function listMessages(userId: string, conversationId: string, opts: { limit: number; cursor?: string }) {
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  if (conv === "forbidden") return "forbidden" as const;

  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [eq(messages.conversation_id, conversationId)];
  if (opts.cursor) {
    const cur = decodeMsgCursor(opts.cursor);
    if (!cur) return "invalid_cursor" as const;
    // (created_at, id) tuple keyset: stable across equal timestamps.
    where.push(dsql`(${messages.created_at}, ${messages.id}) < (${new Date(cur.t)}, ${cur.i}::uuid)`);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(...where))
    .orderBy(desc(messages.created_at), desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const next =
    hasMore && last
      ? Buffer.from(JSON.stringify({ t: last.created_at.toISOString(), i: last.id }), "utf8").toString("base64")
      : null;
  // FE Message shape (web/src/lib/messaging.ts:37) — fields not yet
  // implemented (body_scrubbed, contact_info_detected, admin_visible,
  // attachment_ids, edited_at, deleted_at, gdpr_erased_at) default to
  // safe MVP values.
  const items = slice.reverse().map((m) => ({
    id: m.id,
    conversation_id: m.conversation_id,
    sender_id: m.sender_id,
    body: m.body,
    body_scrubbed: false,
    contact_info_detected: false,
    admin_visible: false,
    attachment_ids: [] as string[],
    created_at: m.created_at.toISOString(),
    edited_at: null,
    deleted_at: null,
    gdpr_erased_at: null,
  }));
  return { items, next_cursor: next, has_more: hasMore };
}

export async function sendMessage(args: {
  user_id: string;
  conversation_id: string;
  body: string;
}): Promise<Result<{ id: string; created_at: string }>> {
  if (args.body.length < 1 || args.body.length > 4000) {
    return err("validation_failed", 400, { fields: { body: "length_1_4000" } });
  }
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, args.conversation_id))
      .limit(1);
    if (rows.length === 0) return err("conversation_not_found", 404);
    const conv = rows[0]!;
    if (conv.client_id !== args.user_id && conv.provider_id !== args.user_id) {
      return err("forbidden", 403);
    }
    if (conv.status !== "open") return err("conversation_closed", 409, { status: conv.status });

    // Deal-scoped conversations: send only if deal is non-terminal. FOR
    // SHARE forces the deal-completion tx (which takes FOR UPDATE) to wait,
    // closing the TOCTOU window between status read and message INSERT.
    if (conv.kind === "deal" && conv.deal_id) {
      const dr = await tx.execute<{ status: string }>(
        dsql`SELECT status FROM deals WHERE id = ${conv.deal_id} FOR SHARE`
      );
      if (dr.length > 0 && (dr[0]!.status === "completed" || dr[0]!.status === "cancelled")) {
        return err("deal_terminal", 409, { deal_status: dr[0]!.status });
      }
    }

    const now = new Date();
    const ins = await tx
      .insert(messages)
      .values({ conversation_id: args.conversation_id, sender_id: args.user_id, body: args.body })
      .returning({ id: messages.id, created_at: messages.created_at });
    const m = ins[0]!;

    await tx
      .update(conversations)
      .set({ last_message_at: now })
      .where(eq(conversations.id, args.conversation_id));

    await tx.insert(outboxEvents).values({
      aggregate_type: "message",
      aggregate_id: m.id,
      event_type: "message.created",
      payload: { message_id: m.id, conversation_id: args.conversation_id, sender_id: args.user_id },
    });

    return { ok: true as const, value: { id: m.id, created_at: m.created_at.toISOString() } };
  });
}

export async function markRead(userId: string, conversationId: string): Promise<Result<{ ok: true }>> {
  // Conditional INSERT — participation enforced inside the same statement,
  // closing the TOCTOU window vs. the prior SELECT-then-INSERT.
  const r = await db.execute<{ conversation_id: string }>(
    dsql`INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
         SELECT ${conversationId}::uuid, ${userId}::uuid, now()
           FROM conversations c
          WHERE c.id = ${conversationId}::uuid
            AND (c.client_id = ${userId}::uuid OR c.provider_id = ${userId}::uuid)
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET last_read_at = EXCLUDED.last_read_at
         RETURNING conversation_id`
  );
  if (r.length === 0) return err("conversation_not_found", 404);
  return { ok: true, value: { ok: true } };
}
