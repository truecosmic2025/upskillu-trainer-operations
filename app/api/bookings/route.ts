import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { confirmationReady, getBooking, listBookings, newId, requireFeature } from "./_lib";

type ProposedDate = { date: string; status: "tbc" | "chosen" | "archived" };

export async function GET() {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const bookings = await listBookings();
  return NextResponse.json({ bookings });
}

export async function POST(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as {
    clientId?: string;
    sessionType?: string;
    proposedDates?: string[];
    deliveryMode?: "in-person" | "virtual";
    venue?: string;
  };
  if (!body.clientId) return NextResponse.json({ error: "A client is required" }, { status: 400 });
  if (!body.sessionType?.trim()) return NextResponse.json({ error: "Session type is required" }, { status: 400 });
  await ensureBookingTables();
  const client = await db().query(`SELECT id FROM clients WHERE id=$1`, [body.clientId]);
  if (!client.rows[0]) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const proposed: ProposedDate[] = (body.proposedDates ?? []).filter(Boolean).map((date) => ({ date, status: "tbc" as const }));
  const id = newId("bkg");
  await db().query(
    `INSERT INTO bookings (id, client_id, session_type, proposed_dates, delivery_mode, venue)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [id, body.clientId, body.sessionType.trim(), JSON.stringify(proposed), body.deliveryMode ?? "in-person", body.venue?.trim() ?? ""],
  );
  await db().query(`INSERT INTO post_session_pipeline (booking_id) VALUES ($1) ON CONFLICT (booking_id) DO NOTHING`, [id]);
  return NextResponse.json({ booking: await getBooking(id) }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as {
    id?: string;
    action?: "update" | "choose_date" | "cancel";
    sessionType?: string;
    venue?: string;
    startTime?: string;
    finishTime?: string;
    deliveryMode?: "in-person" | "virtual";
    addDates?: string[];
    removeDate?: string;
    chosenDate?: string;
  };
  if (!body.id) return NextResponse.json({ error: "Booking id is required" }, { status: 400 });
  const booking = await getBooking(body.id);
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  if (body.action === "cancel") {
    await db().query(`UPDATE bookings SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [body.id]);
    return NextResponse.json({ booking: await getBooking(body.id) });
  }
  if (booking.status === "cancelled") {
    return NextResponse.json({ error: "Cancelled bookings cannot be updated" }, { status: 409 });
  }

  if (body.action === "choose_date") {
    if (!body.chosenDate) return NextResponse.json({ error: "A chosen date is required" }, { status: 400 });
    const proposed = (booking.proposed_dates ?? []) as ProposedDate[];
    if (!proposed.some((p) => p.date === body.chosenDate && p.status === "tbc")) {
      return NextResponse.json({ error: "Chosen date must be one of the held TBC dates" }, { status: 409 });
    }
    const archived = proposed.filter((p) => p.date !== body.chosenDate && p.status === "tbc");
    const next: ProposedDate[] = proposed.map((p) =>
      p.date === body.chosenDate ? { ...p, status: "chosen" as const } : p.status === "tbc" ? { ...p, status: "archived" as const } : p,
    );
    const selectedDate = body.chosenDate;
    const nextStatus = confirmationReady({ confirmed_date: selectedDate, venue: booking.venue, start_time: booking.start_time, finish_time: booking.finish_time })
      ? "confirmed"
      : "to_be_confirmed";
    await db().query(
      `UPDATE bookings SET proposed_dates=$2::jsonb, confirmed_date=$3, status=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [body.id, JSON.stringify(next), selectedDate, nextStatus],
    );
    return NextResponse.json({ booking: await getBooking(body.id), archivedDates: archived.map((p) => p.date) });
  }

  // Default: update details / held dates, then re-evaluate confirmation.
  let proposed = (booking.proposed_dates ?? []) as ProposedDate[];
  if (body.addDates?.length) {
    const existing = new Set(proposed.map((p) => p.date));
    for (const date of body.addDates.filter(Boolean)) if (!existing.has(date)) proposed.push({ date, status: "tbc" });
  }
  if (body.removeDate) {
    const target = proposed.find((p) => p.date === body.removeDate && p.status === "tbc");
    if (!target) return NextResponse.json({ error: "Held date not found" }, { status: 404 });
    proposed = proposed.map((p) => (p.date === body.removeDate && p.status === "tbc" ? { ...p, status: "archived" as const } : p));
  }
  const venue = body.venue !== undefined ? body.venue.trim() : booking.venue;
  const startTime = body.startTime !== undefined ? body.startTime.trim() : booking.start_time;
  const finishTime = body.finishTime !== undefined ? body.finishTime.trim() : booking.finish_time;
  const sessionType = body.sessionType?.trim() || booking.session_type;
  const deliveryMode = body.deliveryMode ?? booking.delivery_mode;
  let status = booking.status;
  if (status === "to_be_confirmed" && confirmationReady({ confirmed_date: booking.confirmed_date, venue, start_time: startTime, finish_time: finishTime })) {
    status = "confirmed";
  }
  if (status === "confirmed" && !confirmationReady({ confirmed_date: booking.confirmed_date, venue, start_time: startTime, finish_time: finishTime })) {
    status = "to_be_confirmed";
  }
  await db().query(
    `UPDATE bookings SET session_type=$2, venue=$3, start_time=$4, finish_time=$5, delivery_mode=$6, proposed_dates=$7::jsonb, status=$8, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [body.id, sessionType, venue, startTime, finishTime, deliveryMode, JSON.stringify(proposed), status],
  );
  const removed = body.removeDate ? [body.removeDate] : [];
  return NextResponse.json({ booking: await getBooking(body.id), archivedDates: removed });
}
