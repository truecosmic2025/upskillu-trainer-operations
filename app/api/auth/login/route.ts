import { NextResponse } from "next/server";
import { createSessionToken } from "../../../../lib/session";
import { publicOrigin } from "../../../../lib/public-url";

export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.redirect(new URL("/login?error=1", publicOrigin(request)), 303);
  }
  if (!process.env.SESSION_SECRET) return NextResponse.json({ error: "Session security is not configured" }, { status: 503 });
  const email = process.env.ADMIN_EMAIL ?? "admin@truecosmic.com";
  const token = await createSessionToken(email, process.env.SESSION_SECRET);
  const response = NextResponse.redirect(new URL("/", publicOrigin(request)), 303);
  response.cookies.set("trainer_ops_session", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 60 * 60 * 12, path: "/" });
  return response;
}
