import { NextResponse } from "next/server";
import { requireTrainerEmail } from "../../../../lib/trainer-portal-auth";
import { createExpense } from "../../../../lib/trainer-operations";
export async function POST(request: Request) {
  const auth = await requireTrainerEmail(); if (auth.error) return auth.error; if (!auth.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try {
    const form = await request.formData(); const file = form.get("receipt"); if (!(file instanceof File)) throw new Error("A receipt upload is required.");
    const expense = await createExpense({ trainerId: auth.email, assignmentId: String(form.get("assignmentId") ?? ""), description: String(form.get("description") ?? ""), amount: Number(form.get("amount")), currency: String(form.get("currency") ?? ""), fileName: file.name, contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json({ expense }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Expense upload failed" }, { status: 400 }); }
}
