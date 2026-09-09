import { NextResponse } from "next/server";
import { requireTrainerEmail } from "../../../../lib/trainer-portal-auth";
import { uploadEvaluation } from "../../../../lib/trainer-operations";
export async function POST(request: Request) {
  const auth = await requireTrainerEmail(); if (auth.error) return auth.error; if (!auth.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try {
    const form = await request.formData(); const file = form.get("file"); const assignmentId = String(form.get("assignmentId") ?? "");
    if (!(file instanceof File)) throw new Error("A PDF or DOCX evaluation file is required.");
    const result = await uploadEvaluation({ trainerId: auth.email, assignmentId, fileName: file.name, contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json({ evaluation: result }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Evaluation upload failed" }, { status: 400 }); }
}
