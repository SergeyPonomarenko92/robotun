import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { listMessages, sendMessage } from "../../../_mock/messaging";
import {
  backfillMessageIdFk,
  validateAttachments,
  projectMessageAttachment,
} from "../../../_mock/media";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit")) || undefined;
  const r = listMessages({
    conversation_id: id,
    caller_user_id: auth.user.id,
    cursor,
    limit,
  });
  if (!r.ok) {
    // not_party and not_found both → 404 (IDOR guard).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // REQ-015: recipient sees attachments only after media_objects.status='ready'.
  // Sender always sees them; we hide non-ready rows from the embed for
  // non-sender callers. body=null for deleted rows is preserved here.
  const enriched = {
    items: r.data.items.map((m) => ({
      ...m,
      attachments: m.attachment_ids
        .map((mid) => projectMessageAttachment(mid))
        .filter((a) => {
          if (!a) return false;
          if (m.sender_id === auth.user.id) return true;
          return a.status === "ready";
        }),
    })),
    next_cursor: r.data.next_cursor,
  };
  return NextResponse.json(enriched);
}

export async function POST(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  let body: { body?: string; attachment_ids?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids
    : [];
  const r = sendMessage({
    conversation_id: id,
    sender_id: auth.user.id,
    body: body.body ?? "",
    attachment_ids: attachmentIds,
    validateAttachments: (ids) => {
      const v = validateAttachments(ids, auth.user.id, "message_attachment");
      let total = 0;
      for (const mid of ids) {
        const proj = projectMessageAttachment(mid);
        if (proj) total += proj.byte_size;
      }
      return { valid: v.valid, total_bytes: total };
    },
  });
  if (!r.ok) {
    if (r.error === "not_party") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (r.error === "conversation_locked") {
      return NextResponse.json({ error: r.error }, { status: 409 });
    }
    return NextResponse.json({ error: r.error }, { status: 400 });
  }
  if (attachmentIds.length > 0) {
    backfillMessageIdFk(attachmentIds, r.message.id);
  }
  return NextResponse.json(
    {
      ...r.message,
      attachments: attachmentIds.map((mid) => projectMessageAttachment(mid)),
    },
    { status: 201 }
  );
}
