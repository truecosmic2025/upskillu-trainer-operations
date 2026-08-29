import { NextResponse } from "next/server";
import { callbackUrl, config, currentStaffEmail, googleScopes } from "../_lib";
import { db, ensureGoogleTables } from "../../../../../lib/db";

export async function GET(request: Request) {
  const userEmail = await currentStaffEmail();
  if (!userEmail) return NextResponse.json({ error:"Authorised TrueCosmic staff sign-in required" }, { status:401 });
  const cfg = config();
  if (!cfg.clientId) return NextResponse.json({ error:"Google integration is not configured yet" }, { status:503 });
  await ensureGoogleTables();
  const state = crypto.randomUUID();
  const expiry = Date.now() + 10 * 60 * 1000;
  await db().query("DELETE FROM oauth_states WHERE expires_at < $1", [Date.now()]);
  await db().query("INSERT INTO oauth_states (state, user_email, expires_at) VALUES ($1, $2, $3)", [state,userEmail,expiry]);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id",cfg.clientId);
  auth.searchParams.set("redirect_uri",callbackUrl(request));
  auth.searchParams.set("response_type","code");
  auth.searchParams.set("scope",googleScopes.join(" "));
  auth.searchParams.set("access_type","offline");
  auth.searchParams.set("prompt","consent");
  auth.searchParams.set("include_granted_scopes","true");
  auth.searchParams.set("state",state);
  auth.searchParams.set("login_hint",cfg.googleAccount);
  return NextResponse.redirect(auth);
}
