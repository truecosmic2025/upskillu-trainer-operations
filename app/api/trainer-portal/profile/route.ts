import { NextResponse } from "next/server";
import { ownTrainerProfile, requireTrainerEmail } from "../../../../lib/trainer-portal-auth";
import { paymentDisclaimer, updateOwnTrainerProfile } from "../../../../lib/trainer-operations";

export async function GET() {
  const auth = await requireTrainerEmail(); if (auth.error) return auth.error; if (!auth.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try { return NextResponse.json({ profile: await ownTrainerProfile(auth.email), paymentDisclaimer: paymentDisclaimer() }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load profile" }, { status: 400 }); }
}
export async function PATCH(request: Request) {
  const auth = await requireTrainerEmail(); if (auth.error) return auth.error; if (!auth.email) return NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 });
  try { const update = await request.json() as Record<string, unknown>; return NextResponse.json({ profile: await updateOwnTrainerProfile(auth.email, update) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update profile" }, { status: 400 }); }
}
