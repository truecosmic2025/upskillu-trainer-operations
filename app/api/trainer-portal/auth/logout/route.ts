import { NextResponse } from "next/server";
import { clearTrainerCookie } from "../../../../../lib/trainer-portal-auth";
import { publicOrigin } from "../../../../../lib/public-url";
export async function POST(request: Request) { return clearTrainerCookie(NextResponse.redirect(new URL("/trainer", publicOrigin(request)), 303)); }
