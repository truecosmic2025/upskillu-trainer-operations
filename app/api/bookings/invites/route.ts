import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../../lib/db";
import { getBooking, requireActiveAccount, requireFeature } from "../_lib";

export async function GET(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const bookingId = request.nextUrl.searchParams.get("bookingId");
  if (!bookingId) return NextResponse.json({ error: "Booking id is required" }, { status: 400 });
  await ensureBookingTables();
  const result = await db().query(
    `SELECT * FROM delivery_invites WHERE booking_id=$1 ORDER BY recipient_type, created_at`,
    [bookingId],
  );
  return NextResponse.json({ invites: result.rows });
}

export async function PATCH(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as {
    bookingId?: string;
    recipientType?: "trainer" | "speaker";
    recipientRef?: string;
    forwarded?: boolean;
  };
  if (!body.bookingId || !body.recipientType || !body.recipientRef || typeof body.forwarded !== "boolean") {
    return NextResponse.json({ error: "Booking id, recipient type, recipient ref and forwarded flag are required" }, { status: 400 });
  }
  const booking = await getBooking(body.bookingId);
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  await db().query(
    `UPDATE delivery_invites
     SET forwarded=$4, forwarded_at=CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END
     WHERE booking_id=$1 AND recipient_type=$2 AND recipient_ref=$3`,
    [body.bookingId, body.recipientType, body.recipientRef, body.forwarded],
  );
  const result = await db().query(
    `SELECT * FROM delivery_invites WHERE booking_id=$1 ORDER BY recipient_type, created_at`,
    [body.bookingId],
  );
  return NextResponse.json({ invites: result.rows });
}
