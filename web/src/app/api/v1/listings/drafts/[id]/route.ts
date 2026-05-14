import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import {
  deleteDraft,
  getDraft,
  patchDraft,
  type DraftPayload,
} from "../../../_mock/listing_drafts";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const r = getDraft(id, auth.user.id);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      // Collapse forbidden→404 so distinct status doesn't leak draft-id existence
      // (IDOR-enumeration mitigation). Internal logs still see the real reason.
      { status: 404 }
    );
  }
  return NextResponse.json(r.draft);
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  let body: DraftPayload;
  try {
    body = (await req.json()) as DraftPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const r = patchDraft(id, auth.user.id, body);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      // Collapse forbidden→404 so distinct status doesn't leak draft-id existence
      // (IDOR-enumeration mitigation). Internal logs still see the real reason.
      { status: 404 }
    );
  }
  return NextResponse.json(r.draft);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await ctx.params;
  const r = deleteDraft(id, auth.user.id);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      // Collapse forbidden→404 so distinct status doesn't leak draft-id existence
      // (IDOR-enumeration mitigation). Internal logs still see the real reason.
      { status: 404 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
