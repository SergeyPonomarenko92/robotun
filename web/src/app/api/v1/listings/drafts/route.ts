import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { createDraft, listDraftsForUser } from "../../_mock/listing_drafts";

export async function POST(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { draft, evicted } = createDraft(auth.user.id);
  return NextResponse.json({ ...draft, evicted }, { status: 201 });
}

export async function GET(req: Request) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const drafts = listDraftsForUser(auth.user.id);
  return NextResponse.json({ items: drafts });
}
