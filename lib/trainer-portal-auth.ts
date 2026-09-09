import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionToken, verifySessionToken } from "./session";
import { db } from "./db";
import { audit, ensureTrainerOperationsTables, getTrainerProfile } from "./trainer-operations";

const TRAINER_COOKIE = "trainer_portal_session";

export async function currentTrainerEmail() {
  const jar = await cookies();
  return verifySessionToken(jar.get(TRAINER_COOKIE)?.value, process.env.SESSION_SECRET);
}

export async function requireTrainerEmail() {
  const email = await currentTrainerEmail();
  if (!email) return { error: NextResponse.json({ error: "Trainer sign-in required" }, { status: 401 }), email: null };
  return { error: null, email };
}

export async function setTrainerCookie(response: NextResponse, email: string) {
  if (!process.env.SESSION_SECRET) throw new Error("Session security is not configured");
  const token = await createSessionToken(email.toLowerCase(), process.env.SESSION_SECRET);
  response.cookies.set(TRAINER_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 60 * 60 * 12, path: "/" });
  return response;
}

export function clearTrainerCookie(response: NextResponse) {
  response.cookies.set(TRAINER_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 0, path: "/" });
  return response;
}

export async function registerTrainer(input: { email: string; password: string; name: string }) {
  await ensureTrainerOperationsTables();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 160 || input.password.length < 12 || input.password.length > 200) throw new Error("Provide a name, valid email, and password of at least 12 characters.");
  const existing = await db().query(`SELECT email FROM trainers WHERE email=$1`, [email]);
  if (existing.rows[0]) throw new Error("A trainer account already exists for this email. Please sign in.");
  const passwordHash = await bcrypt.hash(input.password, 12);
  await db().query(`ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await db().query(`INSERT INTO trainers (email,name,initials) VALUES ($1,$2,$3)`, [email, name, name.split(/\s+/).map((part) => part[0]).join("").slice(0, 5).toUpperCase()]);
  await db().query(`INSERT INTO trainer_profiles (trainer_id,name,contact_email,password_hash) VALUES ($1,$2,$1,$3)`, [email, name, passwordHash]);
  await audit({ sourceType: "trainer_profile", sourceReference: email, actor: email, action: "trainer_account_registered" });
  return email;
}

export async function authenticateTrainer(emailInput: string, password: string) {
  await ensureTrainerOperationsTables();
  await db().query(`ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  const email = emailInput.trim().toLowerCase();
  const result = await db().query<{ password_hash: string | null }>(`SELECT password_hash FROM trainer_profiles WHERE trainer_id=$1`, [email]);
  if (!result.rows[0]?.password_hash || !(await bcrypt.compare(password, result.rows[0].password_hash))) return null;
  return email;
}

export async function ensureGoogleTrainer(email: string, name: string) {
  await ensureTrainerOperationsTables();
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Google account email is invalid");
  const current = await db().query(`SELECT email FROM trainers WHERE email=$1`, [normalized]);
  if (!current.rows[0]) {
    await db().query(`INSERT INTO trainers (email,name,initials) VALUES ($1,$2,$3)`, [normalized, name.slice(0, 160) || normalized, (name || normalized).split(/\s+/).map((part) => part[0]).join("").slice(0, 5).toUpperCase()]);
    await db().query(`INSERT INTO trainer_profiles (trainer_id,name,contact_email) VALUES ($1,$2,$1) ON CONFLICT (trainer_id) DO NOTHING`, [normalized, name.slice(0, 160) || normalized]);
    await audit({ sourceType: "trainer_profile", sourceReference: normalized, actor: normalized, action: "trainer_google_account_registered" });
  }
  return normalized;
}

export async function ownTrainerProfile(email: string) { return getTrainerProfile(email, false); }
export async function ensureAdmin() {
  const jar = await cookies();
  const email = await verifySessionToken(jar.get("trainer_ops_session")?.value, process.env.SESSION_SECRET);
  return email;
}
