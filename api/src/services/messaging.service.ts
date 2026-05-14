/**
 * Module 2 — Messaging (MVP cut).
 *
 * Polling-based. SSE/Redis pub-sub, contact-info detection, moderation,
 * attachments — deferred.
 */
import { and, desc, eq, or, sql as dsql } from "drizzle-orm";
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
  }).catch((e) => {
    if (pgCode(e) === "23505") return err("conversation_exists", 409);
    throw e;
  });
}

/* ---------------------------- list / read -------------------------------- */

export async function listMine(userId: string) {
  const rows = await db
    .select()
    .from(conversations)
    .where(or(eq(conversations.client_id, userId), eq(conversations.provider_id, userId)))
    .orderBy(desc(conversations.last_message_at), desc(conversations.created_at))
    .limit(100);

  // Unread counts via single batch query.
  if (rows.length === 0) return { items: [] as unknown[] };
  const counts = await db.execute<{ conversation_id: string; unread: number }>(
    dsql`SELECT m.conversation_id, COUNT(*)::int AS unread
           FROM messages m
           LEFT JOIN conversation_reads r
             ON r.conversation_id = m.conversation_id AND r.user_id = ${userId}
          WHERE m.conversation_id = ANY(${dsql.raw(`ARRAY[${rows.map(r => `'${r.id}'`).join(",")}]::uuid[]`)})
            AND m.sender_id <> ${userId}
            AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
          GROUP BY m.conversation_id`
  );
  const byConv = new Map(counts.map((c) => [c.conversation_id, c.unread]));

  return {
    items: rows.map((r) => ({ ...r, unread_count: byConv.get(r.id) ?? 0 })),
  };
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

export async function listMessages(userId: string, conversationId: string, opts: { limit: number; before?: string }) {
  const conv = await getConversation(userId, conversationId);
  if (!conv) return null;
  if (conv === "forbidden") return "forbidden" as const;

  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = [eq(messages.conversation_id, conversationId)];
  if (opts.before) {
    where.push(dsql`${messages.created_at} < ${new Date(opts.before)}`);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(...where))
    .orderBy(desc(messages.created_at))
    .limit(limit);
  return { items: rows.reverse() };
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

    // Deal-scoped conversations: send only if deal is non-terminal.
    if (conv.kind === "deal" && conv.deal_id) {
      const dr = await tx
        .select({ status: deals.status })
        .from(deals)
        .where(eq(deals.id, conv.deal_id))
        .limit(1);
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
  const conv = await getConversation(userId, conversationId);
  if (!conv) return err("conversation_not_found", 404);
  if (conv === "forbidden") return err("forbidden", 403);

  await db.execute(
    dsql`INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
         VALUES (${conversationId}, ${userId}, now())
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET last_read_at = EXCLUDED.last_read_at`
  );
  return { ok: true, value: { ok: true } };
}
