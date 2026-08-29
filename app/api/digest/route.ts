import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { newId, requireFeature } from "../bookings/_lib";

function nextWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 Sun … 6 Sat
  const daysUntilMonday = (8 - day) % 7 || 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(monday), end: iso(sunday) };
}

function fmt(date: string | Date) {
  const iso = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export async function GET() {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  await ensureBookingTables();
  const result = await db().query(`SELECT * FROM digest_drafts ORDER BY created_at DESC LIMIT 20`);
  return NextResponse.json({ drafts: result.rows });
}

export async function POST(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as { kind?: "weekly_digest" | "friday_reminder" };
  const kind = body.kind ?? "weekly_digest";
  await ensureBookingTables();
  const { start, end } = nextWeekRange();
  const confirmed = await db().query(
    `SELECT b.*, c.name AS client_name FROM bookings b JOIN clients c ON c.id=b.client_id
     WHERE b.status='confirmed' AND b.confirmed_date BETWEEN $1 AND $2
     ORDER BY b.confirmed_date, b.start_time`,
    [start, end],
  );
  const lines: string[] = [];
  if (kind === "weekly_digest") {
    lines.push(`*Weekly delivery rundown — week of ${fmt(start)}*`, "");
    if (!confirmed.rows.length) {
      lines.push("No confirmed bookings next week.");
    }
    for (const b of confirmed.rows) {
      const team = await db().query(
        `SELECT t.name FROM booking_allocations a JOIN trainers t ON t.email=a.trainer_email WHERE a.booking_id=$1 ORDER BY a.created_at`,
        [b.id],
      );
      const speakers = await db().query(
        `SELECT s.name FROM booking_speakers bs JOIN speakers s ON s.id=bs.speaker_id WHERE bs.booking_id=$1 AND bs.status='confirmed'`,
        [b.id],
      );
      const delivering = [...team.rows.map((r) => r.name), ...speakers.rows.map((r) => `${r.name} (guest speaker)`)].join(", ") || "TBC";
      lines.push(
        `• ${fmt(b.confirmed_date)} — ${b.session_type} (${b.client_name})`,
        `  ${b.start_time}–${b.finish_time} · ${b.delivery_mode === "virtual" ? "Virtual" : b.venue}`,
        `  Delivering: ${delivering}`,
        "",
      );
    }
    lines.push("— Prepared by Trainer Operations. Please review before sharing.");
  } else {
    lines.push(`*Friday reminder — sessions week of ${fmt(start)}*`, "");
    if (!confirmed.rows.length) {
      lines.push("No confirmed sessions next week.");
    }
    for (const b of confirmed.rows) {
      const team = await db().query(
        `SELECT t.name FROM booking_allocations a JOIN trainers t ON t.email=a.trainer_email WHERE a.booking_id=$1 ORDER BY a.created_at`,
        [b.id],
      );
      for (const t of team.rows) {
        lines.push(`• ${t.name}: ${b.session_type} for ${b.client_name} on ${fmt(b.confirmed_date)}, ${b.start_time}–${b.finish_time} (${b.delivery_mode === "virtual" ? "virtual" : b.venue}). Please confirm you have everything you need.`);
      }
    }
    lines.push("", "— Prepared by Trainer Operations. Please review before sharing.");
  }
  const id = newId("dgst");
  await db().query(
    `INSERT INTO digest_drafts (id, kind, week_start, content) VALUES ($1,$2,$3,$4)`,
    [id, kind, start, lines.join("\n")],
  );
  const result = await db().query(`SELECT * FROM digest_drafts WHERE id=$1`, [id]);
  return NextResponse.json({ draft: result.rows[0] }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as { id?: string; approvedBy?: string };
  if (!body.id) return NextResponse.json({ error: "Draft id is required" }, { status: 400 });
  await ensureBookingTables();
  const current = await db().query(`SELECT * FROM digest_drafts WHERE id=$1`, [body.id]);
  if (!current.rows[0]) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  if (current.rows[0].status === "approved") return NextResponse.json({ error: "Draft is already approved" }, { status: 409 });
  await db().query(
    `UPDATE digest_drafts SET status='approved', approved_by=$2, approved_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [body.id, body.approvedBy ?? "admin"],
  );
  const result = await db().query(`SELECT * FROM digest_drafts WHERE id=$1`, [body.id]);
  return NextResponse.json({ draft: result.rows[0] });
}
