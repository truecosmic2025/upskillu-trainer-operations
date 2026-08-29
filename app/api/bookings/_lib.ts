import { NextResponse } from "next/server";
import { db, ensureBookingTables, getEntitlements, type FeatureFlags } from "../../../lib/db";

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function requireFeature(flag: keyof FeatureFlags) {
  const features = await getEntitlements();
  if (!features[flag]) {
    return NextResponse.json({ error: "This feature is not enabled on the current plan" }, { status: 403 });
  }
  return null;
}

export type BookingRow = {
  id: string;
  client_id: string;
  client_name?: string;
  session_type: string;
  proposed_dates: Array<{ date: string; status: "tbc" | "chosen" | "archived" }>;
  confirmed_date: string | null;
  status: "to_be_confirmed" | "confirmed" | "cancelled";
  venue: string;
  start_time: string;
  finish_time: string;
  delivery_mode: "in-person" | "virtual";
  created_at: string;
  updated_at: string;
};

export async function listBookings() {
  await ensureBookingTables();
  const result = await db().query(
    `SELECT b.*, c.name AS client_name FROM bookings b JOIN clients c ON c.id = b.client_id ORDER BY b.created_at DESC`,
  );
  return result.rows as BookingRow[];
}

export async function getBooking(id: string) {
  await ensureBookingTables();
  const result = await db().query(
    `SELECT b.*, c.name AS client_name FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.id=$1`,
    [id],
  );
  return (result.rows[0] as BookingRow | undefined) ?? null;
}

export function confirmationReady(booking: Pick<BookingRow, "venue" | "start_time" | "finish_time">) {
  return Boolean(booking.venue.trim() && booking.start_time.trim() && booking.finish_time.trim());
}
