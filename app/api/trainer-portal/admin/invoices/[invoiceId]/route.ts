import { NextResponse } from "next/server";
import { ensureAdmin } from "../../../../../../lib/trainer-portal-auth";
import { decideInvoice } from "../../../../../../lib/trainer-operations";
export async function PATCH(request: Request, context: { params: Promise<{ invoiceId: string }> }) {
  const admin = await ensureAdmin(); if (!admin) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  try { const body = await request.json() as { decision?: "approved" | "rejected"; rejectedReason?: string }; if (!body.decision || !["approved", "rejected"].includes(body.decision)) throw new Error("decision must be approved or rejected"); const { invoiceId } = await context.params; return NextResponse.json({ invoice: await decideInvoice(invoiceId, body.decision, admin, body.rejectedReason) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to decide invoice" }, { status: 400 }); }
}
