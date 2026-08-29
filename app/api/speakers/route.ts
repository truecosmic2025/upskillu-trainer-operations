import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { getBooking, newId, requireActiveAccount, requireFeature } from "../bookings/_lib";

async function attachToBooking(bookingId: string, speakerId: string) {
  const speaker = await db().query<{ id: string; name: string; contact: string }>(
    `SELECT * FROM speakers WHERE id=$1`,
    [speakerId],
  );
  const row = speaker.rows[0];
  if (!row) return null;
  await db().query(
    `INSERT INTO booking_speakers (id, booking_id, speaker_id)
     VALUES ($1,$2,$3) ON CONFLICT (booking_id, speaker_id) DO NOTHING`,
    [newId("bsp"), bookingId, speakerId],
  );
  // This is tracking only. No invitation is sent or forwarded by this action.
  await db().query(
    `INSERT INTO delivery_invites (id, booking_id, recipient_type, recipient_ref, recipient_name)
     VALUES ($1,$2,'speaker',$3,$4)
     ON CONFLICT (booking_id, recipient_type, recipient_ref) DO NOTHING`,
    [newId("inv"), bookingId, speakerId, row.name],
  );
  return row;
}

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
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("guestSpeakers");
  if (blocked) return blocked;
  const body = (await request.json()) as { name?: string; contact?: string; bookingId?: string; speakerId?: string };
  await ensureBookingTables();

  if (body.bookingId) {
    const booking = await getBooking(body.bookingId);
    if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Add an existing directory speaker to this booking, preserving a single speaker record.
  if (body.speakerId) {
    if (!body.bookingId) return NextResponse.json({ error: "Booking id is required when attaching an existing speaker" }, { status: 400 });
    const speaker = await attachToBooking(body.bookingId, body.speakerId);
    if (!speaker) return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    return NextResponse.json({ speaker, attached: true });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "Speaker name is required" }, { status: 400 });
  const id = newId("spk");
  await db().query(`INSERT INTO speakers (id, name, contact) VALUES ($1,$2,$3)`, [id, body.name.trim(), body.contact?.trim() ?? ""]);
  if (body.bookingId) await attachToBooking(body.bookingId, id);
  const result = await db().query(`SELECT * FROM speakers WHERE id=$1`, [id]);
  return NextResponse.json({ speaker: result.rows[0], attached: Boolean(body.bookingId) }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
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

export async function DELETE(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("guestSpeakers");
  if (blocked) return blocked;
  const body = (await request.json()) as { bookingId?: string; speakerId?: string };
  if (!body.bookingId || !body.speakerId) return NextResponse.json({ error: "Booking id and speaker id are required" }, { status: 400 });
  await ensureBookingTables();
  await db().query(`DELETE FROM booking_speakers WHERE booking_id=$1 AND speaker_id=$2`, [body.bookingId, body.speakerId]);
  await db().query(
    `DELETE FROM delivery_invites WHERE booking_id=$1 AND recipient_type='speaker' AND recipient_ref=$2 AND forwarded=FALSE`,
    [body.bookingId, body.speakerId],
  );
  return NextResponse.json({ removed: true });
}
