import { NextResponse } from "next/server";
import { ensureAdmin } from "../../../../../../lib/trainer-portal-auth";
import { approveOutboundMessage } from "../../../../../../lib/trainer-operations";
export async function PATCH(_request: Request, context: { params: Promise<{ messageId: string }> }) {
  const admin = await ensureAdmin(); if (!admin) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  try { const { messageId } = await context.params; return NextResponse.json({ message: await approveOutboundMessage(messageId, admin) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to approve message" }, { status: 400 }); }
}
