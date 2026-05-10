import { NextResponse } from "next/server";
import { store } from "../../_mock/store";

const PASSWORD_MIN = 12;

export async function POST(req: Request) {
  let body: {
    email?: string;
    password?: string;
    initial_role?: "client" | "provider";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  const initial_role: "client" | "provider" = body.initial_role ?? "client";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "invalid_email" },
      { status: 400 }
    );
  }
  if (password.length < PASSWORD_MIN) {
    return NextResponse.json(
      { error: "weak_password", password_min: PASSWORD_MIN },
      { status: 400 }
    );
  }

  if (store.findUserByEmail(email)) {
    // Module 1: don't leak existence — return success-shape with hint
    return NextResponse.json(
      { error: "email_already_registered" },
      { status: 409 }
    );
  }

  const user = store.createUser({ email, password, initial_role });

  return NextResponse.json(
    { user_id: user.id, email_verification_required: true },
    { status: 201 }
  );
}
