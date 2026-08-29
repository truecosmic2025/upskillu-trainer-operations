import { NextResponse } from "next/server";
import { callbackUrl, config, currentStaffEmail } from "../_lib";
import { db, ensureGoogleTables } from "../../../../../lib/db";

export async function GET(request: Request) {
  const userEmail = await currentStaffEmail();
  if (!userEmail) return NextResponse.json({connected:false,authenticated:false},{status:401});
  const cfg = config();
  await ensureGoogleTables();
  const result = await db().query("SELECT google_email, scopes, updated_at FROM google_connections WHERE user_email = $1", [userEmail]);
  const row = result.rows[0] ?? null;
  return NextResponse.json({connected:Boolean(row),configured:Boolean(cfg.clientId&&cfg.clientSecret&&cfg.encryptionKey),callbackUrl:callbackUrl(request),account:row});
}
