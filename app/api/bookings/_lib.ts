import { NextResponse } from "next/server";
import { db, ensureBookingTables, getEntitlements, type FeatureFlags } from "../../../lib/db";
import { getAccountBilling } from "../../../lib/billing";

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

/** Read operations stay available during a lapse; only account mutations are paused. */
export async function requireActiveAccount() {
  const billing = await getAccountBilling();
  if (billing.status === "past_due" || billing.status === "canceled") {
    return NextResponse.json(
      { error: "This account's subscription needs attention before changes can be made. Contact your administrator." },
      { status: 403 },
    );
  }
  return null;
}

export type BookingRow = {
  id: string;
  client_id: string;
  client_name?: string;
  session_type: string;
  proposed_dates: Array<{ date: string; status: "tbc" | "chosen" | "archived" }>;
  confirmed_date: string | Date | null;
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

export function bookingDateKey(value: unknown) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
}

export function confirmationReady(booking: Pick<BookingRow, "confirmed_date" | "venue" | "start_time" | "finish_time">) {
  // An official booking exists only when a client-selected date and the complete invite details are on record.
  return Boolean(booking.confirmed_date && booking.venue.trim() && booking.start_time.trim() && booking.finish_time.trim());
}
