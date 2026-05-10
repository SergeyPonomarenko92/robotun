import { NextResponse } from "next/server";
import { mintAccessToken, store } from "../../_mock/store";

export async function POST(req: Request) {
  let body: { refresh_token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const refresh = body.refresh_token;
  if (!refresh) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const newSession = store.rotateSession(refresh);
  if (!newSession) {
    return NextResponse.json(
      { error: "refresh_token_invalid" },
      { status: 401 }
    );
  }

  const user = store.findUserById(newSession.user_id);
  if (!user || user.status !== "active") {
    return NextResponse.json(
      { error: "account_unavailable" },
      { status: 403 }
    );
  }

  const { access_token, expires_in } = mintAccessToken(user);
  return NextResponse.json({
    access_token,
    token_type: "Bearer",
    expires_in,
    refresh_token: newSession.refresh_token,
  });
}
