import { NextResponse } from "next/server";
import { store } from "../../_mock/store";

export async function POST(req: Request) {
  let body: { refresh_token?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.refresh_token) {
    store.revokeSession(body.refresh_token);
  }
  return new NextResponse(null, { status: 204 });
}
