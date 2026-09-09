import { NextResponse } from "next/server";
import { db, ensureGoogleTables } from "../../../../../../lib/db";
import { publicOrigin } from "../../../../../../lib/public-url";
import { ensureGoogleTrainer, setTrainerCookie } from "../../../../../../lib/trainer-portal-auth";

export async function GET(request: Request) {
  const url = new URL(request.url); const state = url.searchParams.get("state"); const code = url.searchParams.get("code"); const origin = publicOrigin(request);
  if (!state || !code || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.redirect(new URL("/trainer?error=google", origin));
  await ensureGoogleTables();
  const record = await db().query<{ user_email: string; expires_at: string }>(`DELETE FROM oauth_states WHERE state=$1 RETURNING user_email,expires_at`, [state]);
  if (!record.rows[0] || record.rows[0].user_email !== `trainer:${state}` || Number(record.rows[0].expires_at) < Date.now()) return NextResponse.redirect(new URL("/trainer?error=google", origin));
  const callback = `${origin}/api/trainer-portal/auth/google/callback`;
  const token = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: callback, grant_type: "authorization_code" }) });
  if (!token.ok) return NextResponse.redirect(new URL("/trainer?error=google", origin));
  const tokens = await token.json() as { access_token?: string };
  const user = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tokens.access_token ?? ""}` } });
  const info = await user.json().catch(() => ({})) as { email?: string; name?: string; email_verified?: boolean };
  if (!user.ok || !info.email || info.email_verified === false) return NextResponse.redirect(new URL("/trainer?error=google", origin));
  const email = await ensureGoogleTrainer(info.email, info.name ?? info.email);
  return setTrainerCookie(NextResponse.redirect(new URL("/trainer", origin)), email);
}
