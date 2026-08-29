import { NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../../lib/db";

export async function GET() {
  await ensureBookingTables();
  // Confirmed sessions that have ended but still lack an attendance sheet.
  const overdue = await db().query(
    `SELECT b.id, b.session_type, b.confirmed_date, b.finish_time, c.name AS client_name,
            p.attendance_received_at, p.names_checked, p.shared_with_client, p.evaluation_sent, p.certificates_issued
     FROM bookings b
     JOIN clients c ON c.id = b.client_id
     LEFT JOIN post_session_pipeline p ON p.booking_id = b.id
     WHERE b.status='confirmed' AND b.confirmed_date IS NOT NULL
     ORDER BY b.confirmed_date DESC`,
  );
  const now = Date.now();
  const isoDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
  const items: Array<{ bookingId: string; kind: string; label: string; title: string; detail: string; meta: string; tone: string; pill: string }> = [];
  for (const row of overdue.rows) {
    const end = row.finish_time ? new Date(`${isoDate(row.confirmed_date)}T${row.finish_time}:00`).getTime() : null;
    const ended = end !== null && !Number.isNaN(end) && end < now;
    if (!ended) continue;
    const overdue24 = end !== null && now - end > 24 * 60 * 60 * 1000;
    if (!row.attendance_received_at && overdue24) {
      items.push({
        bookingId: row.id, kind: "attendance", tone: "urgent", pill: "red", label: "OVERDUE",
        title: "Attendance sheet late",
        detail: `${row.session_type} · ${row.client_name}`,
        meta: `Session ended ${new Date(end).toLocaleDateString("en-GB")} · >24h ago`,
      });
    }
    if (row.attendance_received_at && !row.names_checked) {
      items.push({
        bookingId: row.id, kind: "names", tone: "amber", pill: "gold", label: "NEEDS REVIEW",
        title: "Names not checked",
        detail: `${row.session_type} · ${row.client_name}`,
        meta: "Attendance received — names still unchecked",
      });
    }
    if (row.attendance_received_at && row.names_checked && !row.shared_with_client) {
      items.push({
        bookingId: row.id, kind: "share", tone: "amber", pill: "gold", label: "NEEDS REVIEW",
        title: "Not yet shared with client",
        detail: `${row.session_type} · ${row.client_name}`,
        meta: "Checked names awaiting client share",
      });
    }
    if (row.shared_with_client && !row.evaluation_sent) {
      items.push({
        bookingId: row.id, kind: "evaluation", tone: "", pill: "blue", label: "NEXT STEP",
        title: "Evaluation forms to send",
        detail: `${row.session_type} · ${row.client_name}`,
        meta: "Send evaluation forms to participants",
      });
    }
    if (row.evaluation_sent && !row.certificates_issued) {
      items.push({
        bookingId: row.id, kind: "certificates", tone: "", pill: "blue", label: "NEXT STEP",
        title: "Certificates to issue",
        detail: `${row.session_type} · ${row.client_name}`,
        meta: "Issue certificates to completers",
      });
    }
  }
  const unforwarded = await db().query(
    `SELECT i.booking_id, i.recipient_name, i.recipient_type, b.session_type, b.confirmed_date
     FROM delivery_invites i JOIN bookings b ON b.id = i.booking_id
     WHERE i.forwarded=FALSE AND b.status='confirmed'`,
  );
  for (const row of unforwarded.rows) {
    items.push({
      bookingId: row.booking_id, kind: "invite", tone: "amber", pill: "gold", label: "NEEDS REVIEW",
      title: "Client invite not forwarded",
      detail: `${row.recipient_name} (${row.recipient_type}) · ${row.session_type}`,
      meta: row.confirmed_date ? `Session ${new Date(isoDate(row.confirmed_date) + "T00:00:00").toLocaleDateString("en-GB")}` : "Date TBC",
    });
  }
  return NextResponse.json({ items });
}
