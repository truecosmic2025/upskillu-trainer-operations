-- Trainer Operations Phase 1 / Trainer Portal Phase 2
-- Additive PostgreSQL migration. The same idempotent definitions are retained in
-- lib/trainer-operations.ts for the existing on-demand provisioning convention.
BEGIN;

CREATE TABLE IF NOT EXISTS trainer_operation_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS learners (
  learner_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  course_title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  display_timezone TEXT NOT NULL DEFAULT 'Europe/London',
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('virtual','in_person','hybrid')),
  joining_link TEXT,
  joining_link_status TEXT NOT NULL DEFAULT 'missing' CHECK (joining_link_status IN ('missing','pending_verification','verified','replaced','revoked')),
  link_version INTEGER NOT NULL DEFAULT 0 CHECK (link_version >= 0),
  delivery_provider TEXT,
  provider_source_reference TEXT,
  session_host_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_provider_confirmation','verified','communications_open','ready','delivered','cancelled','superseded')),
  supersedes_session_id TEXT REFERENCES sessions(session_id),
  session_fee NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS provider_evidence (
  evidence_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  candidate_joining_link TEXT,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','rejected')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_by TEXT,
  verified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS session_checkpoint_events (
  checkpoint_event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL CHECK (checkpoint IN ('confirmation','pre_session_readiness','business_day_before','session_start_access','post_session_outcomes')),
  subject_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ready','waiting','blocked','escalated','pending')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, checkpoint, subject_reference)
);
CREATE TABLE IF NOT EXISTS learner_assignments (
  assignment_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(learner_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  trainer_id TEXT REFERENCES trainers(email) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('learner','observer','co_facilitator','trainer','administrator')),
  assignment_status TEXT NOT NULL DEFAULT 'proposed' CHECK (assignment_status IN ('proposed','confirmed','declined','cancelled','attended','no_show','outcome_pending')),
  confirmation_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (confirmation_status IN ('not_sent','sent','explicitly_confirmed','declined','bounced','escalated')),
  confirmation_message_id TEXT,
  confirmed_at TIMESTAMPTZ,
  access_status TEXT NOT NULL DEFAULT 'unknown' CHECK (access_status IN ('unknown','joined','admission_blocked','absent','resolved')),
  evaluation_status TEXT NOT NULL DEFAULT 'not_submitted' CHECK (evaluation_status IN ('not_submitted','submitted')),
  job_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (learner_id, session_id)
);
CREATE TABLE IF NOT EXISTS materials (
  material_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  material_url TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  approval_status TEXT NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','submitted','approved','withdrawn','superseded')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  available_from TIMESTAMPTZ,
  preparation_deadline TIMESTAMPTZ,
  delivery_status TEXT NOT NULL DEFAULT 'not_required' CHECK (delivery_status IN ('not_required','pending','sent','receipt_confirmed','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  old_value JSONB,
  new_value JSONB,
  related_message_id TEXT
);
CREATE TABLE IF NOT EXISTS outbound_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES learner_assignments(assignment_id) ON DELETE RESTRICT,
  learner_id TEXT NOT NULL REFERENCES learners(learner_id) ON DELETE RESTRICT,
  link_version INTEGER NOT NULL,
  data_version TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted_for_approval','approved','sent','invalidated','failed')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'trainer_operations_ai',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS access_incidents (
  incident_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
  learner_id TEXT NOT NULL REFERENCES learners(learner_id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES learner_assignments(assignment_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  owner TEXT NOT NULL,
  response_target TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS trainer_profiles (
  trainer_id TEXT PRIMARY KEY REFERENCES trainers(email) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  photo_url TEXT,
  photo_data BYTEA,
  photo_mime TEXT,
  contact_email TEXT NOT NULL,
  contact_phone TEXT NOT NULL DEFAULT '',
  day_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate_currency TEXT NOT NULL DEFAULT 'GBP',
  payment_method TEXT NOT NULL DEFAULT 'other_platform' CHECK (payment_method IN ('paypal','bank_transfer','other_platform')),
  payment_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  password_hash TEXT,
  contract_status TEXT NOT NULL DEFAULT 'pending' CHECK (contract_status IN ('pending','signed','withdrawn')),
  onboarding_stage TEXT NOT NULL DEFAULT 'Observation' CHECK (onboarding_stage IN ('Observation','20%_Delivery','80%_Delivery','100%_Supervised_Assessment','Cleared')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS compliance_documents (
  document_id TEXT PRIMARY KEY,
  trainer_id TEXT NOT NULL REFERENCES trainer_profiles(trainer_id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','expiring_soon','expired')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE REFERENCES learner_assignments(assignment_id) ON DELETE RESTRICT,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('docx','pdf')),
  file_data BYTEA NOT NULL,
  file_size INTEGER NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_to_sasha_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  last_reminder_sent_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id TEXT PRIMARY KEY,
  trainer_id TEXT NOT NULL REFERENCES trainer_profiles(trainer_id) ON DELETE RESTRICT,
  period_month DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_admin_approval' CHECK (status IN ('pending_admin_approval','approved','rejected')),
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  invoice_number TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS invoice_line_items (
  line_item_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES learner_assignments(assignment_id) ON DELETE RESTRICT,
  job_reference TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  session_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  margin NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_admin_approval' CHECK (status IN ('pending_admin_approval','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
  expense_id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(invoice_id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES learner_assignments(assignment_id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL,
  receipt_url TEXT NOT NULL,
  receipt_name TEXT NOT NULL,
  receipt_mime TEXT NOT NULL,
  receipt_data BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_admin_approval','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_invoice_assignment ON invoice_line_items(assignment_id) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_messages_session_assignment ON outbound_messages(session_id, assignment_id, link_version);
CREATE INDEX IF NOT EXISTS idx_assignments_trainer ON learner_assignments(trainer_id, session_id);

ALTER TABLE learners ADD COLUMN IF NOT EXISTS display_timezone TEXT NOT NULL DEFAULT 'Europe/London';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS host_access_confirmed_at TIMESTAMPTZ;

INSERT INTO trainer_operation_settings (key, value) VALUES
  ('assistant_instruction', '{"version":"trainer-operations-v1.0.0","instruction":"See source-controlled versioned instruction in lib/trainer-operations.ts"}'::jsonb),
  ('evaluation_reminders', '{"enabled":false,"firstReminderHours":48,"repeatHours":72,"escalationDays":7,"pendingInvoiceDays":7}'::jsonb),
  ('session_checkpoints', '{"enabled":false,"confirmationOffsetHours":0,"preSessionReadinessHours":72,"businessDayBeforeDays":1,"sessionStartWindowMinutes":30,"postSessionOutcomeHours":2,"businessHoursStart":9,"businessHoursEnd":17}'::jsonb),
  ('invoicing', '{"upskilluInvoiceCutoffDay":15,"sashaEmail":"sasha@upskillu.org"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
COMMIT;
