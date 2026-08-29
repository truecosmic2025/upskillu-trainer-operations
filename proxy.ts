import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "./lib/session";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path.startsWith("/api/auth/") || path === "/api/billing/webhook" || path === "/api/settings/logo" || path.startsWith("/_next/") || path === "/favicon.ico" || path === "/og.png") return NextResponse.next();
  const email = await verifySessionToken(request.cookies.get("trainer_ops_session")?.value, process.env.SESSION_SECRET);
  if (email) return NextResponse.next();
  if (path.startsWith("/api/")) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
