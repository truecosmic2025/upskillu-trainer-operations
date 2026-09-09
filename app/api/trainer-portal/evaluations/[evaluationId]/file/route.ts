import { NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../../../../lib/db";
import { ensureAdmin, requireTrainerEmail } from "../../../../../../lib/trainer-portal-auth";
import { ensureTrainerOperationsTables } from "../../../../../../lib/trainer-operations";
export async function GET(_request: Request, context: { params: Promise<{ evaluationId: string }> }) {
  const trainer = await requireTrainerEmail(); const admin = trainer.error ? await ensureAdmin() : null;
  if (trainer.error && !admin) return trainer.error || NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  await ensureBookingTables(); await ensureTrainerOperationsTables(); const { evaluationId } = await context.params;
  const result = await db().query<{ file_data: Buffer; file_name: string; file_type: string; trainer_id: string }>(`SELECT e.file_data,e.file_name,e.file_type,a.trainer_id FROM evaluations e JOIN learner_assignments a ON a.assignment_id=e.assignment_id WHERE e.evaluation_id=$1`, [evaluationId]);
  const file = result.rows[0]; if (!file || (!admin && file.trainer_id !== trainer.email)) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(file.file_data), { headers: { "content-type": file.file_type === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="${file.file_name.replaceAll('"', "")}"` } });
}
