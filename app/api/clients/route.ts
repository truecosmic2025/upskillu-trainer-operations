import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { newId, requireActiveAccount, requireFeature } from "../bookings/_lib";

export async function GET(request: NextRequest) {
  const blocked = await requireFeature("clients");
  if (blocked) return blocked;
  await ensureBookingTables();
  const clientId = request.nextUrl.searchParams.get("clientId");
  if (clientId) {
    const client = await db().query(`SELECT * FROM clients WHERE id=$1`, [clientId]);
    if (!client.rows[0]) return NextResponse.json({ error: "Client not found" }, { status: 404 });
    const bookings = await db().query(
      `SELECT id, session_type, status, confirmed_date, venue, start_time, finish_time, delivery_mode, created_at
       FROM bookings WHERE client_id=$1 ORDER BY COALESCE(confirmed_date, created_at::date) DESC, created_at DESC`,
      [clientId],
    );
    return NextResponse.json({ client: client.rows[0], bookings: bookings.rows });
  }
  const result = await db().query(`SELECT * FROM clients ORDER BY name`);
  return NextResponse.json({ clients: result.rows });
}

export async function POST(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("clients");
  if (blocked) return blocked;
  const body = (await request.json()) as { name?: string; primaryContact?: string; contactEmail?: string; notes?: string };
  if (!body.name?.trim()) return NextResponse.json({ error: "Client name is required" }, { status: 400 });
  await ensureBookingTables();
  const id = newId("cli");
  await db().query(
    `INSERT INTO clients (id, name, primary_contact, contact_email, notes) VALUES ($1,$2,$3,$4,$5)`,
    [id, body.name.trim(), body.primaryContact?.trim() ?? "", body.contactEmail?.trim() ?? "", body.notes?.trim() ?? ""],
  );
  const result = await db().query(`SELECT * FROM clients WHERE id=$1`, [id]);
  return NextResponse.json({ client: result.rows[0] }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  const blocked = await requireFeature("clients");
  if (blocked) return blocked;
  const body = (await request.json()) as { id?: string; name?: string; primaryContact?: string; contactEmail?: string; notes?: string };
  if (!body.id) return NextResponse.json({ error: "Client id is required" }, { status: 400 });
  await ensureBookingTables();
  const current = await db().query(`SELECT * FROM clients WHERE id=$1`, [body.id]);
  if (!current.rows[0]) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  await db().query(
    `UPDATE clients SET name=$2, primary_contact=$3, contact_email=$4, notes=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [
      body.id,
      body.name?.trim() ?? current.rows[0].name,
      body.primaryContact?.trim() ?? current.rows[0].primary_contact,
      body.contactEmail?.trim() ?? current.rows[0].contact_email,
      body.notes?.trim() ?? current.rows[0].notes,
    ],
  );
  const result = await db().query(`SELECT * FROM clients WHERE id=$1`, [body.id]);
  return NextResponse.json({ client: result.rows[0] });
}
