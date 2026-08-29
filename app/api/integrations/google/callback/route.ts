import { NextResponse } from "next/server";
import { callbackUrl, config, currentStaffEmail, encryptToken } from "../_lib";
import { db, ensureGoogleTables } from "../../../../../lib/db";
import { publicOrigin } from "../../../../../lib/public-url";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const userEmail = await currentStaffEmail();
  const cfg = config();
  if (!userEmail || !code || !state) return NextResponse.redirect(new URL("/?google=invalid",origin));
  await ensureGoogleTables();
  const storedResult = await db().query<{user_email:string;expires_at:string}>("DELETE FROM oauth_states WHERE state = $1 RETURNING user_email, expires_at", [state]);
  const stored = storedResult.rows[0];
  if (!stored || stored.user_email !== userEmail || Number(stored.expires_at) < Date.now()) return NextResponse.redirect(new URL("/?google=invalid",origin));
  if (!cfg.clientId || !cfg.clientSecret || !cfg.encryptionKey) return NextResponse.redirect(new URL("/?google=configuration",origin));
  const response = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code,client_id:cfg.clientId,client_secret:cfg.clientSecret,redirect_uri:callbackUrl(request),grant_type:"authorization_code"})});
  if (!response.ok) return NextResponse.redirect(new URL("/?google=exchange",origin));
  const token = await response.json() as {access_token:string;refresh_token?:string;expires_in:number;scope:string};
  const access = await encryptToken(token.access_token,cfg.encryptionKey);
  const refresh = token.refresh_token ? await encryptToken(token.refresh_token,cfg.encryptionKey) : null;
  await db().query("INSERT INTO google_connections (id,user_email,access_token_encrypted,refresh_token_encrypted,expires_at,scopes,updated_at) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP) ON CONFLICT(user_email) DO UPDATE SET access_token_encrypted=excluded.access_token_encrypted, refresh_token_encrypted=COALESCE(excluded.refresh_token_encrypted,google_connections.refresh_token_encrypted), expires_at=excluded.expires_at, scopes=excluded.scopes, updated_at=CURRENT_TIMESTAMP", [crypto.randomUUID(),userEmail,access,refresh,Date.now()+token.expires_in*1000,token.scope]);
  return NextResponse.redirect(new URL("/?google=connected",origin));
}
