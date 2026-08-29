import { NextResponse } from "next/server";
import { publicOrigin } from "../../../../lib/public-url";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", publicOrigin(request)), 303);
  response.cookies.set("trainer_ops_session", "", { httpOnly: true, expires: new Date(0), path: "/" });
  return response;
}
