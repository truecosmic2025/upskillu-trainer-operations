import { NextResponse } from "next/server";
import { ensureAdmin } from "../../../../../lib/trainer-portal-auth";
import { listAdminAttention } from "../../../../../lib/trainer-operations";
export async function GET() { if (!await ensureAdmin()) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 }); return NextResponse.json({ attention: await listAdminAttention() }); }
