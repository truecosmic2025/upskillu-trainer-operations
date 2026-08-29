import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { getBooking, newId, requireFeature } from "../bookings/_lib";

export async function GET(request: NextRequest) {
  const blocked = await requireFeature("guestSpeakers");
  if (blocked) return blocked;
  await ensureBookingTables();
  const bookingId = request.nextUrl.searchParams.get("bookingId");
  const speakers = await db().query(`SELECT * FROM speakers ORDER BY name`);
  let bookingSpeakers: unknown[] = [];
  if (bookingId) {
    const result = await db().query(
      `SELECT bs.*, s.name AS speaker_name, s.contact AS speaker_contact
       FROM booking_speakers bs JOIN speakers s ON s.id = bs.speaker_id
       WHERE bs.booking_id=$1 ORDER BY bs.created_at`,
      [bookingId],
    );
    bookingSpeakers = result.rows;
  }
  return NextResponse.json({ speakers: speakers.rows, bookingSpeakers });
}

export async function POST(request: NextRequest) {
  const blocked = await requireFeature("guestSpeakers");
  if (blocked) return blocked;
  const body = (await request.json()) as { name?: string; contact?: string; bookingId?: string };
  if (!body.name?.trim()) return NextResponse.json({ error: "Speaker name is required" }, { status: 400 });
  await ensureBookingTables();
  const id = newId("spk");
  await db().query(`INSERT INTO speakers (id, name, contact) VALUES ($1,$2,$3)`, [id, body.name.trim(), body.contact?.trim() ?? ""]);
  if (body.bookingId) {
    const booking = await getBooking(body.bookingId);
    if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    await db().query(
      `INSERT INTO booking_speakers (id, booking_id, speaker_id) VALUES ($1,$2,$3) ON CONFLICT (booking_id, speaker_id) DO NOTHING`,
      [newId("bsp"), body.bookingId, id],
    );
    await db().query(
      `INSERT INTO delivery_invites (id, booking_id, recipient_type, recipient_ref, recipient_name)
       VALUES ($1,$2,'speaker',$3,$4) ON CONFLICT (booking_id, recipient_type, recipient_ref) DO NOTHING`,
      [newId("inv"), body.bookingId, id, body.name.trim()],
    );
  }
  const result = await db().query(`SELECT * FROM speakers WHERE id=$1`, [id]);
  return NextResponse.json({ speaker: result.rows[0] }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const blocked = await requireFeature("guestSpeakers");
  if (blocked) return blocked;
  const body = (await request.json()) as { bookingId?: string; speakerId?: string; status?: "pending" | "confirmed" };
  if (!body.bookingId || !body.speakerId || !body.status) {
    return NextResponse.json({ error: "Booking id, speaker id and status are required" }, { status: 400 });
  }
  await ensureBookingTables();
  await db().query(
    `UPDATE booking_speakers SET status=$3 WHERE booking_id=$1 AND speaker_id=$2`,
    [body.bookingId, body.speakerId, body.status],
  );
  const result = await db().query(
    `SELECT bs.*, s.name AS speaker_name, s.contact AS speaker_contact
     FROM booking_speakers bs JOIN speakers s ON s.id = bs.speaker_id WHERE bs.booking_id=$1`,
    [body.bookingId],
  );
  return NextResponse.json({ bookingSpeakers: result.rows });
}
