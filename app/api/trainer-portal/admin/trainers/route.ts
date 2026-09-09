import { NextResponse } from "next/server";
import { db } from "../../../../../lib/db";
import { ensureAdmin } from "../../../../../lib/trainer-portal-auth";
import { adminUpdateTrainerProfile, audit, ensureTrainerOperationsTables, getTrainerProfile } from "../../../../../lib/trainer-operations";
function unauthorized() { return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 }); }
export async function GET() {
  if (!await ensureAdmin()) return unauthorized(); await ensureTrainerOperationsTables();
  const result = await db().query<{ trainer_id: string }>(`SELECT trainer_id FROM trainer_profiles ORDER BY name`);
  return NextResponse.json({ trainers: await Promise.all(result.rows.map((row) => getTrainerProfile(row.trainer_id, true))) });
}
export async function PATCH(request: Request) {
  const admin = await ensureAdmin(); if (!admin) return unauthorized();
  try { const body = await request.json() as { trainerId?: string; dayRate?: unknown; rateCurrency?: unknown; contractStatus?: unknown; onboardingStage?: unknown; name?: unknown; contactEmail?: unknown; contactPhone?: unknown }; if (!body.trainerId) throw new Error("trainerId is required"); return NextResponse.json({ trainer: await adminUpdateTrainerProfile(body.trainerId, body, admin) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update trainer" }, { status: 400 }); }
}
export async function POST(request: Request) {
  const admin = await ensureAdmin(); if (!admin) return unauthorized();
  try {
    const body = await request.json() as { trainerId?: string; documentType?: string; expiryDate?: string; fileUrl?: string; required?: boolean };
    if (!body.trainerId || !body.documentType || !body.expiryDate) throw new Error("trainerId, documentType, and expiryDate are required"); await ensureTrainerOperationsTables();
    const documentId = `compliance_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await db().query(`INSERT INTO compliance_documents (document_id,trainer_id,document_type,expiry_date,required,file_url) VALUES ($1,$2,$3,$4,$5,$6)`, [documentId, body.trainerId, body.documentType.trim().slice(0, 160), body.expiryDate, body.required !== false, body.fileUrl?.slice(0, 1000) ?? null]);
    await audit({ sourceType: "compliance_document", sourceReference: documentId, actor: admin, action: "compliance_document_added", newValue: { trainerId: body.trainerId, documentType: body.documentType, expiryDate: body.expiryDate } });
    return NextResponse.json({ trainer: await getTrainerProfile(body.trainerId, true) }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to add compliance document" }, { status: 400 }); }
}
