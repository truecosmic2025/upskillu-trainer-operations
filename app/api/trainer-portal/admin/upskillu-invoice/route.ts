import { NextRequest, NextResponse } from "next/server";
import { ensureAdmin } from "../../../../../lib/trainer-portal-auth";
import { buildUpskillUInvoiceDraft } from "../../../../../lib/trainer-operations";
export async function GET(request: NextRequest) { if (!await ensureAdmin()) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 }); try { const month = request.nextUrl.searchParams.get("month") ?? ""; return NextResponse.json({ invoiceDraft: await buildUpskillUInvoiceDraft(month) }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to draft invoice" }, { status: 400 }); } }
