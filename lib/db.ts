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

export async function ensureBookingTables() {
  // Preserve the original onboarding tracker as the source for the initial trainer roster.
  await ensureOnboardingTables();
  await db().query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      primary_contact TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      session_type TEXT NOT NULL,
      proposed_dates JSONB NOT NULL DEFAULT '[]'::jsonb,
      confirmed_date DATE,
      status TEXT NOT NULL DEFAULT 'to_be_confirmed' CHECK (status IN ('to_be_confirmed','confirmed','cancelled')),
      venue TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL DEFAULT '',
      finish_time TEXT NOT NULL DEFAULT '',
      delivery_mode TEXT NOT NULL DEFAULT 'in-person' CHECK (delivery_mode IN ('in-person','virtual')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE TABLE IF NOT EXISTS trainers (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      initials TEXT NOT NULL DEFAULT '',
      is_lead BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS trainer_availability (
      id TEXT PRIMARY KEY,
      trainer_email TEXT NOT NULL REFERENCES trainers(email) ON DELETE CASCADE,
      month TEXT NOT NULL,
      potential_available BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (trainer_email, month)
    );
    CREATE TABLE IF NOT EXISTS booking_allocations (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      trainer_email TEXT NOT NULL REFERENCES trainers(email) ON DELETE CASCADE,
      allocated_by TEXT NOT NULL DEFAULT 'admin',
      lead_pick BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (booking_id, trainer_email)
    );
    CREATE INDEX IF NOT EXISTS idx_allocations_booking ON booking_allocations(booking_id);
    CREATE TABLE IF NOT EXISTS speakers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS booking_speakers (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (booking_id, speaker_id)
    );
    CREATE TABLE IF NOT EXISTS delivery_invites (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      recipient_type TEXT NOT NULL CHECK (recipient_type IN ('trainer','speaker')),
      recipient_ref TEXT NOT NULL,
      recipient_name TEXT NOT NULL DEFAULT '',
      forwarded BOOLEAN NOT NULL DEFAULT FALSE,
      forwarded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (booking_id, recipient_type, recipient_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_invites_booking ON delivery_invites(booking_id);
    CREATE TABLE IF NOT EXISTS post_session_pipeline (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
      attendance_received_at TIMESTAMPTZ,
      attendance_late BOOLEAN NOT NULL DEFAULT FALSE,
      names_checked BOOLEAN NOT NULL DEFAULT FALSE,
      shared_with_client BOOLEAN NOT NULL DEFAULT FALSE,
      evaluation_sent BOOLEAN NOT NULL DEFAULT FALSE,
      certificates_issued BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS account_entitlements (
      account_id TEXT PRIMARY KEY,
      features JSONB NOT NULL DEFAULT '{"bookings":true,"guestSpeakers":true,"clients":true,"operationsAgent":false}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS digest_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('weekly_digest','friday_reminder')),
      week_start DATE NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS account_billing (
      account_id TEXT PRIMARY KEY DEFAULT 'default',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','trialing','active','past_due','canceled','comped')),
      ai_addon_active BOOLEAN NOT NULL DEFAULT FALSE,
      trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days IN (0,14)),
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_account_billing_customer ON account_billing(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_account_billing_subscription ON account_billing(stripe_subscription_id);
    CREATE TABLE IF NOT EXISTS agent_usage_log (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT,
      tool_name TEXT NOT NULL,
      tool_input JSONB NOT NULL DEFAULT '{}'::jsonb,
      tool_result JSONB NOT NULL DEFAULT '{}'::jsonb,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_log_account_created ON agent_usage_log(account_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS account_settings (
      account_id TEXT PRIMARY KEY DEFAULT 'default',
      org_name TEXT,
      logo_data BYTEA,
      logo_mime TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_credentials (
      account_id TEXT PRIMARY KEY DEFAULT 'default',
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS delivery_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      booking_reference TEXT NOT NULL,
      trainer_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Awaiting upload',
      file_name TEXT,
      file_mime TEXT,
      file_data BYTEA,
      file_size INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
  `);
  // A deployment starts with the current onboarding trainers already available for allocation.
  // On conflict, do not overwrite an administrator's lead-role decision in the new table.
  await db().query(`
    INSERT INTO trainers (email, name, initials)
    SELECT email, name, initials FROM trainer_onboarding
    ON CONFLICT (email) DO NOTHING
  `);
  await db().query(`
    INSERT INTO delivery_documents (id, title, booking_reference, trainer_name, status)
    VALUES
      ('doc_register_tc_2408_01', 'Register', 'TC-2408-01', 'Max Auer', 'Awaiting upload'),
      ('doc_debrief_tc_2408_01', 'Trainer debrief', 'TC-2408-01', 'Joelle Appiah', 'Needs review'),
      ('doc_presentation_tc_0109_02', 'Presentation', 'TC-0109-02', 'Max Auer', 'Approved')
    ON CONFLICT (id) DO NOTHING
  `);
  // Existing accounts keep any already-provisioned Operations Agent access. New billing webhooks
  // become the ongoing source of truth for this feature and new account defaults are disabled.
  await db().query(`
    UPDATE account_entitlements
    SET features = features || '{"operationsAgent":true}'::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE NOT (features ? 'operationsAgent')
      AND EXISTS (SELECT 1 FROM account_billing b WHERE b.account_id=account_entitlements.account_id AND b.ai_addon_active=TRUE)
  `);
}

export const defaultFeatures = { bookings: true, guestSpeakers: true, clients: true, operationsAgent: false } as const;
export type FeatureFlags = Record<keyof typeof defaultFeatures, boolean>;

export async function getEntitlements(accountId = "default"): Promise<FeatureFlags> {
  await ensureBookingTables();
  await db().query(
    `INSERT INTO account_entitlements (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
  const result = await db().query<{ features: Partial<FeatureFlags> }>(
    `SELECT features FROM account_entitlements WHERE account_id=$1`,
    [accountId],
  );
  return { ...defaultFeatures, ...(result.rows[0]?.features ?? {}) };
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
