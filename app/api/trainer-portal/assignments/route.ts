import { NextResponse } from "next/server";
import { requireTrainerEmail } from "../../../../lib/trainer-portal-auth";
import { listTrainerAssignments } from "../../../../lib/trainer-operations";
export async function GET() {
  const auth = await requireTrainerEmail(); if (auth.error) return auth.error; if (!auth.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try { return NextResponse.json({ assignments: await listTrainerAssignments(auth.email) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load assignments" }, { status: 403 }); }
}
