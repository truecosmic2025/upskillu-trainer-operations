import { NextRequest, NextResponse } from "next/server";
import { db, ensureOnboardingTables } from "../../../../lib/db";
import { googleJson } from "../../../../lib/google";
import { currentStaffEmail } from "../../integrations/google/_lib";

function base64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function POST(request: NextRequest) {
  const staffEmail = await currentStaffEmail();
  if (!staffEmail) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  const { email } = await request.json() as { email?: string };
  if (!email) return NextResponse.json({ error: "Trainer email is required" }, { status: 400 });
  await ensureOnboardingTables();
  const result = await db().query<{name:string;stages:Record<string,{completed?:boolean}>;materials_email_status:string}>(`SELECT name, stages, materials_email_status FROM trainer_onboarding WHERE email=$1`, [email]);
  const trainer = result.rows[0];
  if (!trainer) return NextResponse.json({ error: "Trainer not found" }, { status: 404 });
  if (!trainer.stages?.observe?.completed) return NextResponse.json({ error: "Observation must be confirmed first" }, { status: 409 });
  if (trainer.materials_email_status === "draft_ready") return NextResponse.json({ error: "A course-material request draft already exists" }, { status: 409 });

  const subject = `Course materials request — ${trainer.name}`;
  const body = `Hi Sasha,\r\n\r\n${trainer.name} has completed the observation stage of the TrueCosmic trainer onboarding pathway.\r\n\r\nPlease could you send all relevant UpskillU course materials they will need to study for their forthcoming co-presenting and delivery sessions?\r\n\r\nKind regards,\r\nMichael Sutherland\r\nTrueCosmic`;
  const raw = base64Url(`To: Sasha Saheva <sasha@upskillu.org>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`);
  const draft = await googleJson<{id:string}>(staffEmail, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
  await db().query(`UPDATE trainer_onboarding SET materials_email_status='draft_ready', materials_draft_id=$2, updated_by='gmail-draft', updated_at=CURRENT_TIMESTAMP WHERE email=$1`, [email, draft.id]);
  const updated = await db().query(`SELECT * FROM trainer_onboarding WHERE email=$1`, [email]);
  return NextResponse.json({ trainer: updated.rows[0], draftId: draft.id });
}
