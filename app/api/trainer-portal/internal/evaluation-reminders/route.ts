import { NextRequest, NextResponse } from "next/server";
import { runEvaluationReminderCycle, runSessionCheckpointCycle } from "../../../../../lib/trainer-operations";
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || supplied !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ sessionCheckpoints: await runSessionCheckpointCycle(), evaluationReminders: await runEvaluationReminderCycle() }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Reminder cycle failed" }, { status: 500 }); }
}
