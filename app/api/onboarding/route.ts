import { NextRequest, NextResponse } from "next/server";
import { db, ensureOnboardingTables } from "../../../lib/db";

const stageIds = ["observe", "present_25", "present_50", "present_75"];

export async function GET() {
  await ensureOnboardingTables();
  const result = await db().query(`SELECT * FROM trainer_onboarding ORDER BY name`);
  return NextResponse.json({ trainers: result.rows });
}

export async function PATCH(request: NextRequest) {
  await ensureOnboardingTables();
  const body = await request.json() as {
    email?: string;
    stage?: string;
    completed?: boolean;
    source?: "admin" | "ai";
    fastTrack?: boolean;
    prepareMaterialsEmail?: boolean;
  };
  if (!body.email) return NextResponse.json({ error: "Trainer email is required" }, { status: 400 });

  if (body.fastTrack) {
    const completed = Object.fromEntries(stageIds.map(stage => [stage, { completed: true, source: "admin-fast-track", confirmedAt: new Date().toISOString() }]));
    await db().query(
      `UPDATE trainer_onboarding SET stages=$2::jsonb, fast_tracked=TRUE, materials_email_status='draft_ready', updated_by='admin-fast-track', updated_at=CURRENT_TIMESTAMP WHERE email=$1`,
      [body.email, JSON.stringify(completed)],
    );
  } else if (body.prepareMaterialsEmail) {
    await db().query(`UPDATE trainer_onboarding SET materials_email_status='draft_ready', updated_by='admin', updated_at=CURRENT_TIMESTAMP WHERE email=$1`, [body.email]);
  } else if (body.stage && stageIds.includes(body.stage) && typeof body.completed === "boolean") {
    const value = body.completed ? { completed: true, source: body.source ?? "admin", confirmedAt: new Date().toISOString() } : { completed: false };
    await db().query(
      `UPDATE trainer_onboarding SET stages=jsonb_set(stages, ARRAY[$2]::text[], $3::jsonb, TRUE), fast_tracked=FALSE, updated_by=$4, updated_at=CURRENT_TIMESTAMP WHERE email=$1`,
      [body.email, body.stage, JSON.stringify(value), body.source ?? "admin"],
    );
    if (body.stage === "observe" && body.completed) {
      await db().query(`UPDATE trainer_onboarding SET materials_email_status='ready_to_prepare' WHERE email=$1 AND materials_email_status='not_ready'`, [body.email]);
    }
  } else {
    return NextResponse.json({ error: "A valid onboarding action is required" }, { status: 400 });
  }

  const result = await db().query(`SELECT * FROM trainer_onboarding WHERE email=$1`, [body.email]);
  return NextResponse.json({ trainer: result.rows[0] });
}
