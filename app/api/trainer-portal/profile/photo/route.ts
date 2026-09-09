import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../../lib/db";
import { ensureAdmin, requireTrainerEmail } from "../../../../../lib/trainer-portal-auth";
import { ensureTrainerOperationsTables, uploadTrainerPhoto } from "../../../../../lib/trainer-operations";
export async function GET(request: NextRequest) {
  const trainer = await requireTrainerEmail(); const admin = trainer.error ? await ensureAdmin() : null;
  if (trainer.error && !admin) return trainer.error || NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  const trainerId = admin ? request.nextUrl.searchParams.get("trainer") : trainer.email;
  if (!trainerId) return NextResponse.json({ error: "Trainer is required" }, { status: 400 });
  await ensureTrainerOperationsTables(); const result = await db().query<{ photo_data: Buffer; photo_mime: string }>(`SELECT photo_data,photo_mime FROM trainer_profiles WHERE trainer_id=$1`, [trainerId]); const photo = result.rows[0];
  if (!photo?.photo_data || !photo.photo_mime) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(photo.photo_data), { headers: { "content-type": photo.photo_mime, "cache-control": "private, max-age=3600" } });
}
export async function POST(request: Request) {
  const trainer = await requireTrainerEmail(); if (trainer.error) return trainer.error; if (!trainer.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try { const form = await request.formData(); const photo = form.get("photo"); if (!(photo instanceof File)) throw new Error("A PNG or JPEG photo is required."); return NextResponse.json({ profile: await uploadTrainerPhoto(trainer.email, photo.name, photo.type, new Uint8Array(await photo.arrayBuffer())) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Photo upload failed" }, { status: 400 }); }
}
