import { NextResponse } from "next/server";
import { db } from "../../../../../../lib/db";
import { ensureAdmin, requireTrainerEmail } from "../../../../../../lib/trainer-portal-auth";
import { ensureTrainerOperationsTables } from "../../../../../../lib/trainer-operations";
export async function GET(_request: Request, context: { params: Promise<{ expenseId: string }> }) {
  const trainer = await requireTrainerEmail(); const admin = trainer.error ? await ensureAdmin() : null;
  if (trainer.error && !admin) return trainer.error || NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  await ensureTrainerOperationsTables(); const { expenseId } = await context.params;
  const result = await db().query<{ receipt_data: Buffer; receipt_name: string; receipt_mime: string; trainer_id: string }>(`SELECT e.receipt_data,e.receipt_name,e.receipt_mime,a.trainer_id FROM expenses e JOIN learner_assignments a ON a.assignment_id=e.assignment_id WHERE e.expense_id=$1`, [expenseId]);
  const file = result.rows[0]; if (!file || (!admin && file.trainer_id !== trainer.email)) return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(file.receipt_data), { headers: { "content-type": file.receipt_mime, "content-disposition": `attachment; filename="${file.receipt_name.replaceAll('"', "")}"` } });
}
