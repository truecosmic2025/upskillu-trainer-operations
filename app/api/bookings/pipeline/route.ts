import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../../lib/db";
import { bookingDateKey, getBooking, requireFeature } from "../_lib";

const flagFields = ["names_checked", "shared_with_client", "evaluation_sent", "certificates_issued"] as const;
type FlagField = (typeof flagFields)[number];

export async function GET(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const bookingId = request.nextUrl.searchParams.get("bookingId");
  await ensureBookingTables();
  if (bookingId) {
    const result = await db().query(`SELECT * FROM post_session_pipeline WHERE booking_id=$1`, [bookingId]);
    return NextResponse.json({ pipeline: result.rows[0] ?? null });
  }
  const result = await db().query(
    `SELECT p.*, b.session_type, b.confirmed_date, b.finish_time, b.status, c.name AS client_name
     FROM post_session_pipeline p
     JOIN bookings b ON b.id = p.booking_id
     JOIN clients c ON c.id = b.client_id
     ORDER BY b.confirmed_date DESC NULLS LAST`,
  );
  return NextResponse.json({ pipelines: result.rows });
}

export async function PATCH(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as {
    bookingId?: string;
    field?: FlagField | "attendance_received";
    value?: boolean;
  };
  if (!body.bookingId || !body.field) {
    return NextResponse.json({ error: "Booking id and field are required" }, { status: 400 });
  }
  const booking = await getBooking(body.bookingId);
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  await db().query(`INSERT INTO post_session_pipeline (booking_id) VALUES ($1) ON CONFLICT (booking_id) DO NOTHING`, [body.bookingId]);

  if (body.field === "attendance_received") {
    // Flag as late when the sheet arrives more than 24h after the session end.
    let late = false;
    if (booking.confirmed_date && booking.finish_time) {
      const sessionEnd = new Date(`${bookingDateKey(booking.confirmed_date)}T${booking.finish_time}:00`);
      if (!Number.isNaN(sessionEnd.getTime())) late = Date.now() - sessionEnd.getTime() > 24 * 60 * 60 * 1000;
    }
    await db().query(
      `UPDATE post_session_pipeline SET attendance_received_at=CURRENT_TIMESTAMP, attendance_late=$2, updated_at=CURRENT_TIMESTAMP WHERE booking_id=$1`,
      [body.bookingId, late],
    );
  } else if (flagFields.includes(body.field as FlagField)) {
    await db().query(
      `UPDATE post_session_pipeline SET ${body.field}=$2, updated_at=CURRENT_TIMESTAMP WHERE booking_id=$1`,
      [body.bookingId, Boolean(body.value)],
    );
  } else {
    return NextResponse.json({ error: "Unknown pipeline field" }, { status: 400 });
  }
  const result = await db().query(`SELECT * FROM post_session_pipeline WHERE booking_id=$1`, [body.bookingId]);
  return NextResponse.json({ pipeline: result.rows[0] });
}
