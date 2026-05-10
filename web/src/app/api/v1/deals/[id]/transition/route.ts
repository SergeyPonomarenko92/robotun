import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { dealsStore, projectDeal } from "../../../_mock/deals";

const ACTIONS = ["accept", "reject", "cancel"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = body.action;
  if (!action || !ACTIONS.includes(action as Action)) {
    return NextResponse.json(
      { error: "invalid_action", allowed: ACTIONS },
      { status: 400 }
    );
  }

  const result = dealsStore.transition(id, auth.user.id, action as Action);
  if ("error" in result) {
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "forbidden"
          ? 403
          : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(projectDeal(result));
}
