import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../../lib/db";
import { ensureAdmin } from "../../../../../lib/trainer-portal-auth";
import { assignTrainerToSession, confirmSessionAccessPathway, createSession, ensureTrainerOperationsTables, ingestProviderEvidence, replaceSessionLink, verifyProviderEvidence } from "../../../../../lib/trainer-operations";

export async function GET() {
  if (!await ensureAdmin()) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  await ensureTrainerOperationsTables();
  const sessions = await db().query(`SELECT session_id,course_id,course_title,starts_at,ends_at,display_timezone,delivery_mode,joining_link_status,link_version,session_host_id,status,session_fee FROM sessions ORDER BY starts_at DESC`);
  return NextResponse.json({ sessions: sessions.rows });
}
export async function POST(request: NextRequest) {
  const admin = await ensureAdmin(); if (!admin) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "replace_link") return NextResponse.json({ session: await replaceSessionLink({ sessionId: String(body.sessionId ?? ""), joiningLink: String(body.joiningLink ?? ""), deliveryProvider: String(body.deliveryProvider ?? ""), providerSourceReference: String(body.providerSourceReference ?? "") }, admin) });
    if (body.action === "ingest_provider_evidence") return NextResponse.json({ evidence: await ingestProviderEvidence({ sessionId: String(body.sessionId ?? ""), providerName: String(body.providerName ?? ""), sourceReference: String(body.sourceReference ?? ""), candidateJoiningLink: typeof body.candidateJoiningLink === "string" ? body.candidateJoiningLink : undefined }, admin) }, { status: 201 });
    if (body.action === "verify_provider_evidence") return NextResponse.json({ session: await verifyProviderEvidence(String(body.evidenceId ?? ""), admin) });
    if (body.action === "confirm_access_pathway") return NextResponse.json({ access: await confirmSessionAccessPathway(String(body.sessionId ?? ""), admin) });
    if (body.action === "assign_trainer") return NextResponse.json({ assignment: await assignTrainerToSession({ sessionId: String(body.sessionId ?? ""), learnerId: String(body.learnerId ?? ""), learnerName: String(body.learnerName ?? ""), learnerEmail: String(body.learnerEmail ?? ""), trainerId: String(body.trainerId ?? ""), jobReference: typeof body.jobReference === "string" ? body.jobReference : undefined, overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : undefined }, admin) }, { status: 201 });
    return NextResponse.json({ session: await createSession({ sessionId: String(body.sessionId ?? ""), courseId: String(body.courseId ?? ""), courseTitle: String(body.courseTitle ?? ""), startsAt: String(body.startsAt ?? ""), endsAt: String(body.endsAt ?? ""), displayTimezone: typeof body.displayTimezone === "string" ? body.displayTimezone : undefined, deliveryMode: body.deliveryMode as "virtual" | "in_person" | "hybrid", joiningLink: typeof body.joiningLink === "string" ? body.joiningLink : undefined, joiningLinkStatus: body.joiningLinkStatus as "missing" | "pending_verification" | "verified" | undefined, deliveryProvider: typeof body.deliveryProvider === "string" ? body.deliveryProvider : undefined, providerSourceReference: typeof body.providerSourceReference === "string" ? body.providerSourceReference : undefined, sessionHostId: typeof body.sessionHostId === "string" ? body.sessionHostId : undefined, sessionFee: typeof body.sessionFee === "number" ? body.sessionFee : undefined, status: typeof body.status === "string" ? body.status : undefined }, admin) }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to manage session" }, { status: 400 }); }
}
