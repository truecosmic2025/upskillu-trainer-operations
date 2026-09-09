import { NextResponse } from "next/server";
import { requireTrainerEmail } from "../../../../lib/trainer-portal-auth";
import { submitInvoice } from "../../../../lib/trainer-operations";
export async function POST(request: Request) {
  const auth = await requireTrainerEmail(); if (auth.error) return auth.error; if (!auth.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try { const body = await request.json() as { assignmentIds?: string[]; expenseIds?: string[]; periodMonth?: string }; return NextResponse.json({ invoice: await submitInvoice({ trainerId: auth.email, assignmentIds: Array.isArray(body.assignmentIds) ? body.assignmentIds : [], expenseIds: Array.isArray(body.expenseIds) ? body.expenseIds : [], periodMonth: String(body.periodMonth ?? "") }) }, { status: 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invoice submission failed" }, { status: 400 }); }
}
