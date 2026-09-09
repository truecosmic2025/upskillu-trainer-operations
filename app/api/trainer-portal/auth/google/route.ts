import { NextResponse } from "next/server";
import { db, ensureGoogleTables } from "../../../../../lib/db";
import { publicOrigin } from "../../../../../lib/public-url";

export async function GET(request: Request) {
  if (!process.env.GOOGLE_CLIENT_ID) return NextResponse.redirect(new URL("/trainer?error=google_configuration", publicOrigin(request)));
  await ensureGoogleTables();
  const state = crypto.randomUUID();
  await db().query(`INSERT INTO oauth_states (state,user_email,expires_at) VALUES ($1,$2,$3)`, [state, `trainer:${state}`, Date.now() + 10 * 60_000]);
  const callback = `${publicOrigin(request)}/api/trainer-portal/auth/google/callback`;
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
