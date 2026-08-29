import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../../lib/db";
import { getBooking, newId, requireActiveAccount, requireFeature } from "../_lib";

export async function GET(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const bookingId = request.nextUrl.searchParams.get("bookingId");
  await ensureBookingTables();
  if (bookingId) {
    const result = await db().query(
      `SELECT a.*, t.name AS trainer_name, t.is_lead FROM booking_allocations a JOIN trainers t ON t.email = a.trainer_email WHERE a.booking_id=$1 ORDER BY a.created_at`,
      [bookingId],
    );
    return NextResponse.json({ allocations: result.rows });
  }
  const result = await db().query(
    `SELECT a.*, t.name AS trainer_name, t.is_lead FROM booking_allocations a JOIN trainers t ON t.email = a.trainer_email ORDER BY a.created_at DESC`,
  );
  return NextResponse.json({ allocations: result.rows });
}

export async function POST(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as { bookingId?: string; trainerEmail?: string; allocatedBy?: string };
  if (!body.bookingId || !body.trainerEmail) {
    return NextResponse.json({ error: "Booking id and trainer email are required" }, { status: 400 });
  }
  const booking = await getBooking(body.bookingId);
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (booking.status === "cancelled") return NextResponse.json({ error: "Cancelled bookings cannot be allocated" }, { status: 409 });
  const trainer = await db().query(`SELECT email, is_lead FROM trainers WHERE email=$1`, [body.trainerEmail]);
  if (!trainer.rows[0]) return NextResponse.json({ error: "Trainer not found" }, { status: 404 });
  const leadPick = Boolean(trainer.rows[0].is_lead);
  await db().query(
    `INSERT INTO booking_allocations (id, booking_id, trainer_email, allocated_by, lead_pick)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (booking_id, trainer_email) DO NOTHING`,
    [newId("alc"), body.bookingId, body.trainerEmail, body.allocatedBy ?? "admin", leadPick],
  );
  // Ensure an invite-tracking row exists for the newly allocated trainer.
  const trainerRow = await db().query(`SELECT name FROM trainers WHERE email=$1`, [body.trainerEmail]);
  await db().query(
    `INSERT INTO delivery_invites (id, booking_id, recipient_type, recipient_ref, recipient_name)
     VALUES ($1,$2,'trainer',$3,$4)
     ON CONFLICT (booking_id, recipient_type, recipient_ref) DO NOTHING`,
    [newId("inv"), body.bookingId, body.trainerEmail, trainerRow.rows[0]?.name ?? ""],
  );
  const result = await db().query(
    `SELECT a.*, t.name AS trainer_name, t.is_lead FROM booking_allocations a JOIN trainers t ON t.email = a.trainer_email WHERE a.booking_id=$1 ORDER BY a.created_at`,
    [body.bookingId],
  );
  return NextResponse.json({ allocations: result.rows }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as { bookingId?: string; trainerEmail?: string };
  if (!body.bookingId || !body.trainerEmail) {
    return NextResponse.json({ error: "Booking id and trainer email are required" }, { status: 400 });
  }
  await ensureBookingTables();
  await db().query(`DELETE FROM booking_allocations WHERE booking_id=$1 AND trainer_email=$2`, [body.bookingId, body.trainerEmail]);
  await db().query(
    `DELETE FROM delivery_invites WHERE booking_id=$1 AND recipient_type='trainer' AND recipient_ref=$2 AND forwarded=FALSE`,
    [body.bookingId, body.trainerEmail],
  );
  const result = await db().query(
    `SELECT a.*, t.name AS trainer_name, t.is_lead FROM booking_allocations a JOIN trainers t ON t.email = a.trainer_email WHERE a.booking_id=$1 ORDER BY a.created_at`,
    [body.bookingId],
  );
  return NextResponse.json({ allocations: result.rows });
}
