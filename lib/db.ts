import { Pool } from "pg";

declare global { var trainerOpsPool: Pool | undefined; }

export function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  global.trainerOpsPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });
  return global.trainerOpsPool;
}

export async function ensureGoogleTables() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS google_connections (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL UNIQUE,
      google_email TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at BIGINT NOT NULL,
      scopes TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
  `);
}

export async function ensureOnboardingTables() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS trainer_onboarding (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      initials TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      stages JSONB NOT NULL DEFAULT '{}'::jsonb,
      materials_email_status TEXT NOT NULL DEFAULT 'not_ready',
      materials_draft_id TEXT,
      fast_tracked BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE trainer_onboarding ADD COLUMN IF NOT EXISTS materials_draft_id TEXT;
  `);
  const roster = [
    ["auer.max.jr@gmail.com", "Max Auer", "MA", "In-person + virtual"],
    ["joelle.shopr@gmail.com", "Joelle Appiah", "JA", "In-person + virtual"],
    ["valmwangi14@gmail.com", "Valentine Wairimu", "VW", "Virtual only"],
    ["hadassahheadley@gmail.com", "Hadassah Headley", "HH", "Virtual only"],
    ["joshua.prem2025@gmail.com", "Ranjit Nankani", "RN", "Role to verify"],
  ];
  for (const [email, name, initials, deliveryMode] of roster) {
    await db().query(
      `INSERT INTO trainer_onboarding (email, name, initials, delivery_mode)
       VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING`,
      [email, name, initials, deliveryMode],
    );
  }
}
