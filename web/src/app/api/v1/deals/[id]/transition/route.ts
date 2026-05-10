import { NextResponse } from "next/server";
import { authorize } from "../../../_mock/store";
import { dealsStore, projectDeal } from "../../../_mock/deals";

const ACTIONS = [
  "accept",
  "reject",
  "cancel",
  "submit",
  "approve",
  "dispute",
] as const;
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

  // Demo backdoor: the seeded provider@robotun.dev user can act as provider
  // on any deal, working around the synthetic listing-provider-ID seam in
  // the mock listings catalog. Production backend has real FKs.
  const demoActAsProvider = auth.user.email === "provider@robotun.dev";

  const result = dealsStore.transition(
    id,
    auth.user.id,
    action as Action,
    demoActAsProvider
  );
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
