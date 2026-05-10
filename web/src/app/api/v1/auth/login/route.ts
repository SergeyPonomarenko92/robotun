import { NextResponse } from "next/server";
import { mintAccessToken, store } from "../../_mock/store";

export async function POST(req: Request) {
  // Module 1 AC-004: constant-time floor of 300ms — applies whether email
  // exists or not, to prevent user enumeration via timing.
  const floor = new Promise((r) => setTimeout(r, 300));

  let body: { email?: string; password?: string; totp?: string };
  try {
    body = await req.json();
  } catch {
    await floor;
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    await floor;
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const user = store.findUserByEmail(email);
  const credsOk = user && user.password === password;

  if (!credsOk || !user) {
    await floor;
    return NextResponse.json(
      { error: "invalid_credentials" },
      { status: 401 }
    );
  }

  if (user.status !== "active") {
    await floor;
    return NextResponse.json(
      { error: "account_unavailable" },
      { status: 403 }
    );
  }

  const session = store.createSession(user.id);
  const { access_token, expires_in } = mintAccessToken(user);

  await floor;
  return NextResponse.json({
    access_token,
    token_type: "Bearer",
    expires_in,
    refresh_token: session.refresh_token,
  });
}
