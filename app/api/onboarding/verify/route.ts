import { NextRequest, NextResponse } from "next/server";
import { db, ensureOnboardingTables } from "../../../../lib/db";
import { googleJson } from "../../../../lib/google";
import { currentStaffEmail } from "../../integrations/google/_lib";

const terms: Record<string, string> = {
  observe: "observation OR observe OR observer",
  present_25: '"25%" OR "25 percent"',
  present_50: '"50%" OR "50 percent"',
  present_75: '"75%" OR "75 percent"',
};

export async function POST(request: NextRequest) {
  const staffEmail = await currentStaffEmail();
  if (!staffEmail) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  const body = await request.json() as { email?: string; stage?: string };
  if (!body.email || !body.stage || !terms[body.stage]) return NextResponse.json({ error: "Trainer and stage are required" }, { status: 400 });
  await ensureOnboardingTables();
  const trainerResult = await db().query<{name:string}>(`SELECT name FROM trainer_onboarding WHERE email=$1`, [body.email]);
  const trainer = trainerResult.rows[0];
  if (!trainer) return NextResponse.json({ error: "Trainer not found" }, { status: 404 });

  const query = `in:anywhere (${body.email} OR "${trainer.name}") (${terms[body.stage]})`;
  const gmail = await googleJson<{messages?:Array<{id:string}>;resultSizeEstimate?:number}>(staffEmail, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(query)}`);
  const calendar = await googleJson<{items?:Array<{id:string;summary?:string}>}>(staffEmail, `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&maxResults=20&q=${encodeURIComponent(`${trainer.name} ${terms[body.stage].replaceAll(' OR ', ' ')}`)}`);
  const emailEvidence = gmail.messages?.length ?? 0;
  const calendarEvidence = calendar.items?.length ?? 0;
  if (!emailEvidence && !calendarEvidence) return NextResponse.json({ error: "AI found no matching Gmail or Calendar evidence. Please confirm this stage manually." }, { status: 409 });

  const value = { completed: true, source: "ai", confirmedAt: new Date().toISOString(), evidence: { emailEvidence, calendarEvidence } };
  await db().query(
    `UPDATE trainer_onboarding SET stages=jsonb_set(stages, ARRAY[$2]::text[], $3::jsonb, TRUE), fast_tracked=FALSE, updated_by='ai-evidence-check', updated_at=CURRENT_TIMESTAMP WHERE email=$1`,
    [body.email, body.stage, JSON.stringify(value)],
  );
  if (body.stage === "observe") await db().query(`UPDATE trainer_onboarding SET materials_email_status='ready_to_prepare' WHERE email=$1 AND materials_email_status='not_ready'`, [body.email]);
  const updated = await db().query(`SELECT * FROM trainer_onboarding WHERE email=$1`, [body.email]);
  return NextResponse.json({ trainer: updated.rows[0], evidence: { emailEvidence, calendarEvidence } });
}
