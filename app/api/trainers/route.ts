import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { newId, requireFeature } from "../bookings/_lib";

export async function GET(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  await ensureBookingTables();
  const month = request.nextUrl.searchParams.get("month");
  const trainers = await db().query(`SELECT * FROM trainers ORDER BY is_lead DESC, name`);
  let availability: unknown[] = [];
  if (month) {
    const result = await db().query(
      `SELECT trainer_email, month, potential_available FROM trainer_availability WHERE month=$1`,
      [month],
    );
    availability = result.rows;
  }
  return NextResponse.json({ trainers: trainers.rows, availability });
}

export async function POST(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as { name?: string; email?: string; initials?: string; isLead?: boolean };
  if (!body.name?.trim() || !body.email?.trim()) {
    return NextResponse.json({ error: "Trainer name and email are required" }, { status: 400 });
  }
  await ensureBookingTables();
  const email = body.email.trim().toLowerCase();
  const initials = body.initials?.trim() || body.name.trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase();
  await db().query(
    `INSERT INTO trainers (email, name, initials, is_lead) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, initials=EXCLUDED.initials, is_lead=EXCLUDED.is_lead`,
    [email, body.name.trim(), initials, Boolean(body.isLead)],
  );
  const result = await db().query(`SELECT * FROM trainers WHERE email=$1`, [email]);
  return NextResponse.json({ trainer: result.rows[0] }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const blocked = await requireFeature("bookings");
  if (blocked) return blocked;
  const body = (await request.json()) as {
    email?: string;
    isLead?: boolean;
    month?: string;
    potentialAvailable?: boolean;
  };
  if (!body.email) return NextResponse.json({ error: "Trainer email is required" }, { status: 400 });
  await ensureBookingTables();
  const trainer = await db().query(`SELECT email FROM trainers WHERE email=$1`, [body.email]);
  if (!trainer.rows[0]) return NextResponse.json({ error: "Trainer not found" }, { status: 404 });

  if (typeof body.isLead === "boolean") {
    await db().query(`UPDATE trainers SET is_lead=$2 WHERE email=$1`, [body.email, body.isLead]);
  }
  if (body.month && typeof body.potentialAvailable === "boolean") {
    await db().query(
      `INSERT INTO trainer_availability (id, trainer_email, month, potential_available)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (trainer_email, month) DO UPDATE SET potential_available=EXCLUDED.potential_available`,
      [newId("avl"), body.email, body.month, body.potentialAvailable],
    );
  }
  const result = await db().query(`SELECT * FROM trainers WHERE email=$1`, [body.email]);
  return NextResponse.json({ trainer: result.rows[0] });
}
