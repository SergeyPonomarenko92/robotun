import { NextResponse } from "next/server";
import { authorize } from "../../_mock/store";
import { dealsStore, projectDeal } from "../../_mock/deals";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = authorize(req.headers.get("authorization"));
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;
  const deal = dealsStore.find(id);
  if (!deal) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Module 3: only client/provider/admin can read.
  const me = auth.user;
  const isParty = me.id === deal.client_id || me.id === deal.provider_id;
  const isAdmin = me.roles.includes("admin");
  if (!isParty && !isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(projectDeal(deal));
}
