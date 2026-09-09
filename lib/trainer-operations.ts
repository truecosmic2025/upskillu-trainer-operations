import { db, ensureBookingTables } from "./db";
import { googleJson } from "./google";

export const TRAINER_OPERATIONS_INSTRUCTION_VERSION = "trainer-operations-v1.0.0";
export const TRAINER_OPERATIONS_SYSTEM_INSTRUCTION = `You are the Trainer Operations assistant.

The Trainer Operations database is the sole source of truth for operational facts. Do not infer a session, learner assignment, date, weekday, timezone, joining link, host, material status, or attendance outcome from email history, previous chat messages, a similarly named session, or general knowledge.

Before drafting or sending any learner communication, retrieve the verified session and the learner's assignment for the specified session ID. Use only the returned date/time/timezone/link/material records. Generate the weekday from the session start datetime; never type or transform it independently.

Never send or expose an unverified, replaced, revoked, unpublished, or cross-session joining link or material. Never treat an outbound email as participant confirmation. Explicit learner acknowledgement is required for a next-day session.

If a required record is missing, conflicting, expired, unapproved, or unconfirmed, do not send. Return a concise blocked alert containing the session ID, learner, missing evidence, owner, and next action.

Do not bypass validation. Escalate link changes, late assignments, access/admission incidents, no-shows, cancellations, and manual overrides to a human owner. Record all actions through the application audit workflow.`;

export type AssignmentReadinessStatus = "Ready" | "Waiting" | "Blocked" | "Escalated";
export type ReadinessBlocker = { code: string; message: string; owner: string; nextAction: string; assignmentId?: string };
export type ReadinessResult = {
  sessionId: string;
  readiness: "ready" | "waiting" | "blocked" | "escalated";
  generatedWeekday: string | null;
  displayTimezone: string | null;
  blockers: ReadinessBlocker[];
  assignments: Array<{ assignmentId: string; learnerId: string; learnerName: string; status: AssignmentReadinessStatus; owner: string; reason: string }>;
};

type SessionRecord = {
  session_id: string; course_id: string; course_title: string; starts_at: string | Date; ends_at: string | Date;
  display_timezone: string; delivery_mode: "virtual" | "in_person" | "hybrid"; joining_link: string | null;
  joining_link_status: string; link_version: number; delivery_provider: string | null; provider_source_reference: string | null;
  session_host_id: string | null; host_access_confirmed_at: string | Date | null; status: string; supersedes_session_id: string | null; session_fee: string | number | null;
};

type AssignmentRecord = {
  assignment_id: string; learner_id: string; session_id: string; role: string; assignment_status: string;
  confirmation_status: string; confirmation_message_id: string | null; confirmed_at: string | Date | null;
  access_status: string; evaluation_status: string; job_reference: string | null; learner_name: string; learner_email: string;
};

function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`; }
function asText(value: unknown, label: string, limit = 400) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > limit) throw new Error(`${label} is required and must be ${limit} characters or fewer`);
  return text;
}
function isEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function htmlEscape(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }
function base64Url(value: string) { return Buffer.from(value, "utf8").toString("base64url"); }
async function privateAuditReference(value: string) {
  if (!isEmail(value)) return value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.toLowerCase()));
  return `account_${Array.from(new Uint8Array(digest)).slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** Removes values that must not appear in application audit/debug records. */
export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);
  if (typeof value === "string") return isEmail(value) || /^https?:\/\//i.test(value) ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /email|link|url|body|subject|recipient|contact|file_data|receipt_data/i.test(key) ? "[redacted]" : redactForAudit(item)]));
}
function dateKey(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function weekday(value: string | Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: timezone }).format(new Date(value));
}
/** Canonical display helper; no stored or user-supplied weekday is accepted anywhere. */
export function generatedWeekday(startsAt: string | Date, timezone = "Europe/London") { return weekday(startsAt, timezone); }
function humanDate(value: string | Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: timezone }).format(new Date(value));
}
function humanTime(value: string | Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(value));
}
function isNextDay(value: string | Date, timezone: string, now = new Date()) {
  const today = dateKey(now, timezone);
  const tomorrow = new Date(`${today}T12:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return dateKey(new Date(value), timezone) === tomorrow.toISOString().slice(0, 10);
}
function businessDayBefore(sessionDate: string, businessDays: number) {
  const date = new Date(`${sessionDate}T12:00:00.000Z`);
  for (let remaining = businessDays; remaining > 0;) {
    date.setUTCDate(date.getUTCDate() - 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}
function isWithinBusinessHours(now: Date, timezone: string, startHour: number, endHour: number) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
  const weekdayIndex = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
  return !["Sat", "Sun"].includes(weekdayIndex) && hour >= startHour && hour < endHour;
}
function toNumber(value: string | number | null | undefined) { return Number(value ?? 0); }

export async function ensureTrainerOperationsTables() {
  await ensureBookingTables();
  await db().query(`
    CREATE TABLE IF NOT EXISTS trainer_operation_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS provider_evidence (
      evidence_id TEXT PRIMARY KEY,
      session_id TEXT,
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
      session_id TEXT NOT NULL,
      checkpoint TEXT NOT NULL CHECK (checkpoint IN ('confirmation','pre_session_readiness','business_day_before','session_start_access','post_session_outcomes')),
      subject_reference TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('ready','waiting','blocked','escalated','pending')),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (session_id, checkpoint, subject_reference)
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
    CREATE INDEX IF NOT EXISTS idx_messages_session_assignment ON outbound_messages(session_id, assignment_id, link_version);
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
      contact_email TEXT NOT NULL,
      contact_phone TEXT NOT NULL DEFAULT '',
      day_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      rate_currency TEXT NOT NULL DEFAULT 'GBP',
      payment_method TEXT NOT NULL DEFAULT 'other_platform' CHECK (payment_method IN ('paypal','bank_transfer','other_platform')),
      payment_details JSONB NOT NULL DEFAULT '{}'::jsonb,
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_invoice_assignment ON invoice_line_items(assignment_id) WHERE status <> 'rejected';
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
    CREATE INDEX IF NOT EXISTS idx_assignments_trainer ON learner_assignments(trainer_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_evaluations_assignment ON evaluations(assignment_id);
    ALTER TABLE learners ADD COLUMN IF NOT EXISTS display_timezone TEXT NOT NULL DEFAULT 'Europe/London';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS host_access_confirmed_at TIMESTAMPTZ;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS photo_data BYTEA;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS photo_mime TEXT;
  `);
  await db().query(`
    INSERT INTO trainer_operation_settings (key, value) VALUES
      ('assistant_instruction', $1::jsonb),
      ('evaluation_reminders', '{"enabled":false,"firstReminderHours":48,"repeatHours":72,"escalationDays":7}'::jsonb),
      ('invoicing', '{"upskilluInvoiceCutoffDay":15,"sashaEmail":"sasha@upskillu.org"}'::jsonb),
      ('session_checkpoints', '{"enabled":false,"confirmationOffsetHours":0,"preSessionReadinessHours":72,"businessDayBeforeDays":1,"sessionStartWindowMinutes":30,"postSessionOutcomeHours":2,"businessHoursStart":9,"businessHoursEnd":17}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=CURRENT_TIMESTAMP
      WHERE trainer_operation_settings.key='assistant_instruction'
        AND trainer_operation_settings.value->>'instruction' LIKE 'See source%'
  `, [JSON.stringify({ version: TRAINER_OPERATIONS_INSTRUCTION_VERSION, instruction: TRAINER_OPERATIONS_SYSTEM_INSTRUCTION })]);
  await db().query(`
    INSERT INTO trainer_profiles (trainer_id, name, contact_email)
    SELECT email, name, email FROM trainers
    ON CONFLICT (trainer_id) DO NOTHING
  `);
}

export async function audit(input: { sourceType: string; sourceReference: string; actor: string; action: string; oldValue?: unknown; newValue?: unknown; relatedMessageId?: string }) {
  await ensureTrainerOperationsTables();
  await db().query(
    `INSERT INTO audit_log (id, source_type, source_reference, actor, action, old_value, new_value, related_message_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [id("audit"), input.sourceType, await privateAuditReference(input.sourceReference), await privateAuditReference(input.actor), input.action, JSON.stringify(redactForAudit(input.oldValue ?? null)), JSON.stringify(redactForAudit(input.newValue ?? null)), input.relatedMessageId ?? null],
  );
}

async function sessionRow(sessionId: string) {
  await ensureTrainerOperationsTables();
  const result = await db().query<SessionRecord>(`SELECT * FROM sessions WHERE session_id=$1`, [asText(sessionId, "sessionId", 180)]);
  return result.rows[0] ?? null;
}
async function assignmentRow(learnerId: string, sessionId: string) {
  await ensureTrainerOperationsTables();
  const result = await db().query<AssignmentRecord>(`
    SELECT a.*, l.full_name AS learner_name, l.email AS learner_email
    FROM learner_assignments a JOIN learners l ON l.learner_id=a.learner_id
    WHERE a.learner_id=$1 AND a.session_id=$2`, [asText(learnerId, "learnerId", 180), asText(sessionId, "sessionId", 180)]);
  return result.rows[0] ?? null;
}
function sessionBlockers(session: SessionRecord | null): ReadinessBlocker[] {
  if (!session) return [{ code: "session_missing", message: "Session record is missing.", owner: "Trainer Operations", nextAction: "Create or select the immutable session ID." }];
  const blockers: ReadinessBlocker[] = [];
  if (["draft", "cancelled", "superseded"].includes(session.status)) blockers.push({ code: "session_status", message: `Session is ${session.status}.`, owner: "Trainer Operations", nextAction: "Verify or replace the session before communicating." });
  if (!session.delivery_provider?.trim() || !session.provider_source_reference?.trim()) blockers.push({ code: "provider_unverified", message: "Verified provider source is missing.", owner: "Trainer Operations", nextAction: "Record the provider and source reference." });
  if (session.joining_link_status !== "verified" || !session.joining_link?.trim()) blockers.push({ code: "link_unverified", message: "The current joining link is not verified.", owner: "Trainer Operations", nextAction: "Verify the provider-issued link for this session." });
  if (["pending_verification", "replaced", "revoked"].includes(session.joining_link_status)) blockers.push({ code: "link_change", message: `Joining link status is ${session.joining_link_status}.`, owner: "Trainer Operations", nextAction: "Resolve the link change and issue a new verified version." });
  if (["virtual", "hybrid"].includes(session.delivery_mode) && !session.session_host_id?.trim()) blockers.push({ code: "host_missing", message: "Virtual admission host is missing.", owner: "Trainer Operations", nextAction: "Assign the named session host." });
  try { weekday(session.starts_at, session.display_timezone); } catch { blockers.push({ code: "datetime_invalid", message: "Canonical session datetime or timezone is invalid.", owner: "Trainer Operations", nextAction: "Correct starts_at or display_timezone." }); }
  return blockers;
}

export async function getSession(sessionId: string) {
  const session = await sessionRow(sessionId);
  if (!session) throw new Error(`Blocked — session ${sessionId} is missing. Owner: Trainer Operations. Action: select a valid session ID.`);
  const verified = session.joining_link_status === "verified" && Boolean(session.joining_link) && Boolean(session.delivery_provider) && Boolean(session.provider_source_reference);
  return {
    sessionId: session.session_id, courseId: session.course_id, courseTitle: session.course_title, startsAt: session.starts_at,
    endsAt: session.ends_at, displayTimezone: session.display_timezone, generatedWeekday: weekday(session.starts_at, session.display_timezone),
    deliveryMode: session.delivery_mode, joiningLink: verified ? session.joining_link : null, joiningLinkStatus: session.joining_link_status,
    linkVersion: session.link_version, deliveryProvider: verified ? session.delivery_provider : null, sessionHostId: session.session_host_id,
    status: session.status, supersedesSessionId: session.supersedes_session_id,
  };
}

export async function createSession(input: { sessionId: string; courseId: string; courseTitle: string; startsAt: string; endsAt: string; displayTimezone?: string; deliveryMode: "virtual" | "in_person" | "hybrid"; joiningLink?: string; joiningLinkStatus?: "missing" | "pending_verification" | "verified"; deliveryProvider?: string; providerSourceReference?: string; sessionHostId?: string; sessionFee?: number; status?: string }, actor: string) {
  await ensureTrainerOperationsTables();
  const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt); const timezone = input.displayTimezone?.trim() || "Europe/London";
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new Error("startsAt and endsAt must be valid canonical datetimes, with endsAt after startsAt.");
  try { weekday(startsAt, timezone); } catch { throw new Error("displayTimezone must be a valid IANA timezone."); }
  const status = input.status ?? "verified"; const linkStatus = input.joiningLinkStatus ?? (input.joiningLink ? "pending_verification" : "missing");
  if (linkStatus === "verified" && (!input.joiningLink || !input.deliveryProvider || !input.providerSourceReference)) throw new Error("A verified link requires the link, delivery provider, and provider source reference.");
  await db().query(`INSERT INTO sessions (session_id,course_id,course_title,starts_at,ends_at,display_timezone,delivery_mode,joining_link,joining_link_status,link_version,delivery_provider,provider_source_reference,session_host_id,status,session_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [asText(input.sessionId, "sessionId", 180), asText(input.courseId, "courseId", 180), asText(input.courseTitle, "courseTitle", 240), startsAt.toISOString(), endsAt.toISOString(), timezone, input.deliveryMode, input.joiningLink?.trim() || null, linkStatus, input.joiningLink ? 1 : 0, input.deliveryProvider?.trim() || null, input.providerSourceReference?.trim() || null, input.sessionHostId?.trim() || null, status, input.sessionFee ?? null]);
  await audit({ sourceType: "session", sourceReference: input.sessionId, actor, action: "session_created", newValue: { startsAt: startsAt.toISOString(), timezone, generatedWeekday: weekday(startsAt, timezone), linkStatus } });
  return getSession(input.sessionId);
}

export async function replaceSessionLink(input: { sessionId: string; joiningLink: string; deliveryProvider: string; providerSourceReference: string }, actor: string) {
  const session = await sessionRow(input.sessionId);
  if (!session || ["cancelled", "superseded"].includes(session.status)) throw new Error("A current, non-cancelled session is required for a link replacement.");
  const joiningLink = asText(input.joiningLink, "joiningLink", 2000); const provider = asText(input.deliveryProvider, "deliveryProvider", 240); const source = asText(input.providerSourceReference, "providerSourceReference", 1000);
  const changed = joiningLink !== session.joining_link; const version = changed ? session.link_version + 1 : session.link_version || 1;
  await db().query(`UPDATE sessions SET joining_link=$2,joining_link_status='verified',link_version=$3,delivery_provider=$4,provider_source_reference=$5,updated_at=CURRENT_TIMESTAMP WHERE session_id=$1`, [session.session_id, joiningLink, version, provider, source]);
  if (changed) {
    await db().query(`UPDATE outbound_messages SET status='invalidated',updated_at=CURRENT_TIMESTAMP WHERE session_id=$1 AND status IN ('draft','submitted_for_approval','approved')`, [session.session_id]);
    await db().query(`UPDATE learner_assignments SET confirmation_status='not_sent',confirmation_message_id=NULL,confirmed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE session_id=$1 AND assignment_status NOT IN ('cancelled','declined')`, [session.session_id]);
  }
  await audit({ sourceType: "session", sourceReference: session.session_id, actor, action: changed ? "session_link_replaced" : "session_link_reverified", oldValue: { linkVersion: session.link_version }, newValue: { linkVersion: version } });
  return getSession(session.session_id);
}

/** Provider email data remains evidence until a human explicitly verifies it. */
export async function ingestProviderEvidence(input: { sessionId: string; providerName: string; sourceReference: string; candidateJoiningLink?: string }, actor: string) {
  await ensureTrainerOperationsTables();
  const session = await sessionRow(input.sessionId); if (!session) throw new Error("A valid sessionId is required before provider evidence can be recorded.");
  const evidenceId = id("provider_evidence");
  await db().query(`INSERT INTO provider_evidence (evidence_id,session_id,provider_name,source_reference,candidate_joining_link,status) VALUES ($1,$2,$3,$4,$5,'unverified')`, [evidenceId, session.session_id, asText(input.providerName, "providerName", 240), asText(input.sourceReference, "sourceReference", 1000), input.candidateJoiningLink?.trim() || null]);
  await audit({ sourceType: "provider_evidence", sourceReference: evidenceId, actor, action: "provider_evidence_ingested_unverified", newValue: { sessionId: session.session_id, provider: input.providerName } });
  return { evidenceId, sessionId: session.session_id, status: "unverified" };
}

export async function verifyProviderEvidence(evidenceId: string, actor: string) {
  await ensureTrainerOperationsTables();
  const result = await db().query<{ evidence_id: string; session_id: string; provider_name: string; source_reference: string; candidate_joining_link: string | null; status: string }>(`SELECT * FROM provider_evidence WHERE evidence_id=$1`, [asText(evidenceId, "evidenceId", 180)]);
  const evidence = result.rows[0]; if (!evidence || evidence.status !== "unverified" || !evidence.candidate_joining_link) throw new Error("Only unverified provider evidence with a candidate link can be human-verified.");
  await db().query(`UPDATE provider_evidence SET status='verified',verified_by=$2,verified_at=CURRENT_TIMESTAMP WHERE evidence_id=$1`, [evidence.evidence_id, actor]);
  const session = await replaceSessionLink({ sessionId: evidence.session_id, joiningLink: evidence.candidate_joining_link, deliveryProvider: evidence.provider_name, providerSourceReference: evidence.source_reference }, actor);
  await audit({ sourceType: "provider_evidence", sourceReference: evidence.evidence_id, actor, action: "provider_evidence_human_verified", newValue: { sessionId: evidence.session_id } });
  return session;
}

export async function confirmSessionAccessPathway(sessionId: string, actor: string) {
  const session = await sessionRow(sessionId);
  if (!session || ["cancelled", "superseded"].includes(session.status) || !session.session_host_id) throw new Error("A current virtual or hybrid session with a named host is required for access confirmation.");
  await db().query(`UPDATE sessions SET host_access_confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE session_id=$1`, [session.session_id]);
  await audit({ sourceType: "session", sourceReference: session.session_id, actor, action: "session_host_access_pathway_confirmed", newValue: { sessionHostId: session.session_host_id } });
  return { sessionId: session.session_id, hostId: session.session_host_id, status: "confirmed" };
}

export async function assignTrainerToSession(input: { sessionId: string; learnerId: string; learnerName: string; learnerEmail: string; trainerId: string; jobReference?: string; overrideReason?: string }, actor: string) {
  await ensureTrainerOperationsTables();
  const session = await sessionRow(input.sessionId); if (!session || ["cancelled", "superseded"].includes(session.status)) throw new Error("Cannot assign a trainer to a missing, cancelled, or superseded session.");
  const trainerId = asText(input.trainerId, "trainerId", 320).toLowerCase();
  try { await assertTrainerPortalAccess(trainerId, "assignment"); }
  catch (error) { if (!input.overrideReason?.trim()) throw error; await audit({ sourceType: "trainer_assignment", sourceReference: input.sessionId, actor, action: "assignment_gate_overridden", newValue: { trainerId, reason: input.overrideReason.trim() } }); }
  const learnerId = asText(input.learnerId, "learnerId", 180); const learnerEmail = asText(input.learnerEmail, "learnerEmail", 320).toLowerCase();
  if (!isEmail(learnerEmail)) throw new Error("learnerEmail must be valid.");
  await db().query(`INSERT INTO learners (learner_id,full_name,email) VALUES ($1,$2,$3) ON CONFLICT (learner_id) DO UPDATE SET full_name=EXCLUDED.full_name,email=EXCLUDED.email`, [learnerId, asText(input.learnerName, "learnerName", 160), learnerEmail]);
  const assignmentId = id("assignment");
  await db().query(`INSERT INTO learner_assignments (assignment_id,learner_id,session_id,trainer_id,role,assignment_status,job_reference) VALUES ($1,$2,$3,$4,'trainer','confirmed',$5)`, [assignmentId, learnerId, session.session_id, trainerId, input.jobReference?.trim() || assignmentId]);
  await audit({ sourceType: "learner_assignment", sourceReference: assignmentId, actor, action: "trainer_assigned", newValue: { sessionId: session.session_id, trainerId, learnerId } });
  return { assignmentId, sessionId: session.session_id, trainerId, learnerId };
}

export async function getAssignment(learnerId: string, sessionId: string) {
  const assignment = await assignmentRow(learnerId, sessionId);
  if (!assignment) throw new Error(`Blocked — learner ${learnerId} is not assigned to ${sessionId}. Owner: Trainer Operations. Action: verify the assignment record.`);
  return {
    assignmentId: assignment.assignment_id, learnerId: assignment.learner_id, sessionId: assignment.session_id,
    learnerName: assignment.learner_name, role: assignment.role, assignmentStatus: assignment.assignment_status,
    confirmationStatus: assignment.confirmation_status, accessStatus: assignment.access_status, evaluationStatus: assignment.evaluation_status,
  };
}

export async function getApprovedMaterials(sessionId: string) {
  await ensureTrainerOperationsTables();
  const rows = await db().query<{ material_id: string; title: string; version: string; material_url: string | null; available_from: Date | null; preparation_deadline: Date | null }>(`
    SELECT material_id, title, version, material_url, available_from, preparation_deadline
    FROM materials WHERE session_id=$1 AND approval_status='approved'
      AND (available_from IS NULL OR available_from <= CURRENT_TIMESTAMP)
      AND (preparation_deadline IS NULL OR preparation_deadline >= CURRENT_TIMESTAMP)
    ORDER BY title`, [asText(sessionId, "sessionId", 180)]);
  return rows.rows.map((row) => ({ materialId: row.material_id, title: row.title, version: row.version, materialUrl: row.material_url, availableFrom: row.available_from, preparationDeadline: row.preparation_deadline }));
}

export async function getReadiness(sessionId: string, now = new Date()): Promise<ReadinessResult> {
  const session = await sessionRow(sessionId);
  const blockers = sessionBlockers(session);
  if (!session) return { sessionId, readiness: "blocked", generatedWeekday: null, displayTimezone: null, blockers, assignments: [] };
  const requiredMaterials = await db().query<{ material_id: string; title: string; approval_status: string; available_from: Date | null; preparation_deadline: Date | null }>(`
    SELECT material_id, title, approval_status, available_from, preparation_deadline FROM materials WHERE session_id=$1 AND required=TRUE`, [session.session_id]);
  for (const material of requiredMaterials.rows) {
    if (material.approval_status !== "approved" || (material.available_from && material.available_from > now) || (material.preparation_deadline && material.preparation_deadline < now)) {
      blockers.push({ code: "materials_not_ready", message: `Required material “${material.title}” is not approved and available within its preparation window.`, owner: "Materials owner", nextAction: "Approve, publish, or replace the material." });
    }
  }
  const duplicates = await db().query<{ learner_id: string }>(`SELECT learner_id FROM learner_assignments WHERE session_id=$1 GROUP BY learner_id HAVING COUNT(*) > 1`, [session.session_id]);
  if (duplicates.rows.length) blockers.push({ code: "duplicate_assignment", message: "Duplicate learner assignment conflict exists.", owner: "Trainer Operations", nextAction: "Resolve the duplicate assignment." });
  const rows = await db().query<AssignmentRecord>(`
    SELECT a.*, l.full_name AS learner_name, l.email AS learner_email
    FROM learner_assignments a JOIN learners l ON l.learner_id=a.learner_id
    WHERE a.session_id=$1 AND a.assignment_status NOT IN ('declined','cancelled') ORDER BY l.full_name`, [session.session_id]);
  const assignmentStatuses: ReadinessResult["assignments"] = [];
  for (const assignment of rows.rows) {
    const sent = await db().query<{ message_id: string }>(`SELECT message_id FROM outbound_messages WHERE assignment_id=$1 AND session_id=$2 AND link_version=$3 AND status='sent' ORDER BY sent_at DESC LIMIT 1`, [assignment.assignment_id, session.session_id, session.link_version]);
    const incident = await db().query<{ incident_id: string }>(`SELECT incident_id FROM access_incidents WHERE assignment_id=$1 AND status='open' LIMIT 1`, [assignment.assignment_id]);
    let status: AssignmentReadinessStatus = "Ready";
    let reason = "Current link confirmation and acknowledgement are recorded.";
    const owner = "Trainer Operations";
    if (incident.rows[0] || assignment.confirmation_status === "bounced" || assignment.confirmation_status === "escalated") {
      status = "Escalated"; reason = incident.rows[0] ? "Open admission/access incident." : "Confirmation requires human follow-up.";
      blockers.push({ code: "assignment_escalated", message: `${assignment.learner_name}: ${reason}`, owner: session.session_host_id || "Trainer Operations", nextAction: "Resolve and record the outcome.", assignmentId: assignment.assignment_id });
    } else if (blockers.some((blocker) => ["session_status", "provider_unverified", "link_unverified", "link_change", "host_missing", "datetime_invalid", "materials_not_ready", "duplicate_assignment"].includes(blocker.code))) {
      status = "Blocked"; reason = "Session-level verified evidence is incomplete.";
    } else if (!sent.rows[0]) {
      status = "Waiting"; reason = `No confirmation has been sent for current link version ${session.link_version}.`;
      blockers.push({ code: "confirmation_not_sent", message: `${assignment.learner_name} has no current-link confirmation.`, owner: "Trainer Operations", nextAction: "Draft, approve, and send a confirmation.", assignmentId: assignment.assignment_id });
    } else if (isNextDay(session.starts_at, session.display_timezone, now) && assignment.confirmation_status !== "explicitly_confirmed") {
      status = "Waiting"; reason = "Explicit learner acknowledgement is required for a next-day session.";
      blockers.push({ code: "next_day_acknowledgement_missing", message: `${assignment.learner_name} has not explicitly acknowledged the next-day session.`, owner: "Trainer Operations", nextAction: "Escalate and record an explicit reply.", assignmentId: assignment.assignment_id });
    }
    assignmentStatuses.push({ assignmentId: assignment.assignment_id, learnerId: assignment.learner_id, learnerName: assignment.learner_name, status, owner, reason });
  }
  const states = assignmentStatuses.map((assignment) => assignment.status);
  const readiness = states.includes("Escalated") ? "escalated" : blockers.some((blocker) => !["confirmation_not_sent", "next_day_acknowledgement_missing"].includes(blocker.code)) ? "blocked" : states.includes("Blocked") ? "blocked" : states.includes("Waiting") ? "waiting" : "ready";
  return { sessionId: session.session_id, readiness, generatedWeekday: weekday(session.starts_at, session.display_timezone), displayTimezone: session.display_timezone, blockers, assignments: assignmentStatuses };
}

function communicationBlockers(readiness: ReadinessResult) {
  return readiness.blockers.filter((blocker) => !["confirmation_not_sent", "next_day_acknowledgement_missing"].includes(blocker.code));
}

export async function createConfirmationDraft(sessionId: string, learnerId: string, actor = "Trainer Operations AI") {
  const session = await sessionRow(sessionId);
  const assignment = await assignmentRow(learnerId, sessionId);
  if (!session || !assignment || ["declined", "cancelled"].includes(assignment.assignment_status)) throw new Error(`Blocked — learner ${learnerId} is not actively assigned to ${sessionId}. Owner: Trainer Operations. Action: verify the assignment.`);
  const readiness = await getReadiness(sessionId);
  const blockers = communicationBlockers(readiness);
  if (blockers.length) throw new Error(`Blocked — ${blockers[0].message} Owner: ${blockers[0].owner}. Action: ${blockers[0].nextAction}`);
  const approvedMaterials = await getApprovedMaterials(sessionId);
  const materialText = approvedMaterials.length ? `\nApproved materials:\n${approvedMaterials.map((m) => `- ${m.title} (v${m.version})${m.materialUrl ? `: ${m.materialUrl}` : ""}`).join("\n")}` : "";
  const date = humanDate(session.starts_at, session.display_timezone);
  const time = humanTime(session.starts_at, session.display_timezone);
  const body = `Hello ${assignment.learner_name},\n\nThis is a confirmation for ${session.course_title}.\n\nDate: ${date}\nTime: ${time} (${session.display_timezone})\nJoining link: ${session.joining_link}\nHost for admission: ${session.session_host_id}\n${materialText}\n\nPlease reply to explicitly confirm that you can attend.\n\nTrainer Operations`;
  const messageId = id("msg");
  await db().query(`INSERT INTO outbound_messages (message_id,session_id,assignment_id,learner_id,link_version,data_version,recipient_email,subject,body,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft','trainer_operations_ai')`, [messageId, session.session_id, assignment.assignment_id, assignment.learner_id, session.link_version, `${session.session_id}:link:${session.link_version}`, assignment.learner_email, `Confirmation: ${session.course_title} — ${date}`, body]);
  await audit({ sourceType: "outbound_message", sourceReference: messageId, actor, action: "confirmation_draft_created", newValue: { sessionId, assignmentId: assignment.assignment_id, linkVersion: session.link_version }, relatedMessageId: messageId });
  return { messageId, status: "draft", subject: `Confirmation: ${session.course_title} — ${date}`, body, sessionId: session.session_id, assignmentId: assignment.assignment_id, linkVersion: session.link_version };
}

async function messageForAction(messageId: string) {
  await ensureTrainerOperationsTables();
  const result = await db().query<{ message_id: string; session_id: string; assignment_id: string; learner_id: string; link_version: number; recipient_email: string; subject: string; body: string; status: string }>(`SELECT * FROM outbound_messages WHERE message_id=$1`, [asText(messageId, "messageId", 180)]);
  const message = result.rows[0];
  if (!message) throw new Error("Message record was not found");
  const assignment = await assignmentRow(message.learner_id, message.session_id);
  const session = await sessionRow(message.session_id);
  if (!assignment || !session || assignment.assignment_id !== message.assignment_id || session.link_version !== message.link_version || session.joining_link_status !== "verified" || ["cancelled", "superseded"].includes(session.status)) {
    await db().query(`UPDATE outbound_messages SET status='invalidated',updated_at=CURRENT_TIMESTAMP WHERE message_id=$1 AND status NOT IN ('sent','invalidated')`, [message.message_id]);
    await audit({ sourceType: "outbound_message", sourceReference: message.message_id, actor: "Trainer Operations", action: "message_invalidated", newValue: { reason: "session, assignment, or link changed" }, relatedMessageId: message.message_id });
    throw new Error("Blocked — this draft is no longer valid because the session, assignment, or verified link changed. Owner: Trainer Operations. Action: create a new draft.");
  }
  const readiness = await getReadiness(message.session_id);
  const blockers = communicationBlockers(readiness);
  if (blockers.length) throw new Error(`Blocked — ${blockers[0].message} Owner: ${blockers[0].owner}. Action: ${blockers[0].nextAction}`);
  return { message, session, assignment };
}

export async function submitSendForApproval(messageId: string, actor = "Trainer Operations AI") {
  const { message } = await messageForAction(messageId);
  if (message.status !== "draft") throw new Error("Only a current draft can be submitted for human approval");
  await db().query(`UPDATE outbound_messages SET status='submitted_for_approval',updated_at=CURRENT_TIMESTAMP WHERE message_id=$1`, [message.message_id]);
  await audit({ sourceType: "outbound_message", sourceReference: message.message_id, actor, action: "send_submitted_for_human_approval", relatedMessageId: message.message_id });
  return { messageId: message.message_id, status: "submitted_for_human_approval", nextAction: "A human approver must approve this current draft before it can be sent." };
}

export async function approveOutboundMessage(messageId: string, approver: string) {
  const { message } = await messageForAction(messageId);
  if (message.status !== "submitted_for_approval") throw new Error("Only a submitted message can be approved");
  await db().query(`UPDATE outbound_messages SET status='approved',approved_by=$2,approved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE message_id=$1`, [message.message_id, asText(approver, "approver", 320)]);
  await audit({ sourceType: "outbound_message", sourceReference: message.message_id, actor: approver, action: "message_human_approved", relatedMessageId: message.message_id });
  return { messageId: message.message_id, status: "approved" };
}

async function sendGmailMessage(sender: string, to: string, subject: string, body: string, attachments: Array<{ name: string; mime: string; data: Uint8Array }> = []) {
  if (!isEmail(to)) throw new Error("Message recipient is invalid");
  const boundary = `portal_${crypto.randomUUID().replaceAll("-", "")}`;
  const lines = [
    `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary=${boundary}`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", body,
  ];
  for (const attachment of attachments) {
    lines.push(`--${boundary}`, `Content-Type: ${attachment.mime}; name="${attachment.name.replaceAll('"', "")}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${attachment.name.replaceAll('"', "")}"`, "", Buffer.from(attachment.data).toString("base64"));
  }
  lines.push(`--${boundary}--`, "");
  await googleJson(sender, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw: base64Url(lines.join("\r\n")) }) });
}

export async function sendApprovedMessage(messageId: string, actor = "Trainer Operations") {
  const { message, session, assignment } = await messageForAction(messageId);
  if (message.status !== "approved") throw new Error("Blocked — only a still-valid, previously human-approved message may be sent.");
  const sender = process.env.GOOGLE_WORKSPACE_ACCOUNT;
  if (!sender) throw new Error("Google Workspace sender is not configured");
  await sendGmailMessage(sender, message.recipient_email, message.subject, message.body);
  await db().query(`UPDATE outbound_messages SET status='sent',sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE message_id=$1`, [message.message_id]);
  await db().query(`UPDATE learner_assignments SET confirmation_status='sent',confirmation_message_id=$2,updated_at=CURRENT_TIMESTAMP WHERE assignment_id=$1`, [assignment.assignment_id, message.message_id]);
  await audit({ sourceType: "outbound_message", sourceReference: message.message_id, actor, action: "approved_message_sent", newValue: { sessionId: session.session_id, assignmentId: assignment.assignment_id, linkVersion: message.link_version }, relatedMessageId: message.message_id });
  await recordCheckpoint(session.session_id, "confirmation", assignment.assignment_id, "waiting", { assignmentId: assignment.assignment_id, messageId: message.message_id, linkVersion: message.link_version });
  return { messageId: message.message_id, status: "sent", sessionId: session.session_id, assignmentId: assignment.assignment_id, linkVersion: message.link_version };
}

export async function recordAcknowledgement(messageId: string, learnerId: string, actor = "Trainer Operations") {
  const { message, assignment } = await messageForAction(messageId);
  if (message.status !== "sent" || assignment.learner_id !== asText(learnerId, "learnerId", 180)) throw new Error("Blocked — acknowledgement must reference a sent message and its exact learner assignment.");
  await db().query(`UPDATE learner_assignments SET confirmation_status='explicitly_confirmed',confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE assignment_id=$1`, [assignment.assignment_id]);
  await audit({ sourceType: "learner_assignment", sourceReference: assignment.assignment_id, actor, action: "explicit_acknowledgement_recorded", newValue: { messageId: message.message_id }, relatedMessageId: message.message_id });
  return { assignmentId: assignment.assignment_id, confirmationStatus: "explicitly_confirmed" };
}

export async function recordAccessOutcome(sessionId: string, learnerId: string, status: "joined" | "admission_blocked" | "absent" | "resolved", actor = "Trainer Operations") {
  const assignment = await assignmentRow(learnerId, sessionId);
  const session = await sessionRow(sessionId);
  if (!assignment || !session) throw new Error("Blocked — exact session and learner assignment are required for access outcomes.");
  await db().query(`UPDATE learner_assignments SET access_status=$2,assignment_status=CASE WHEN $2='joined' THEN 'attended' WHEN $2='absent' THEN 'no_show' ELSE assignment_status END,updated_at=CURRENT_TIMESTAMP WHERE assignment_id=$1`, [assignment.assignment_id, status]);
  if (status === "admission_blocked") {
    await db().query(`INSERT INTO access_incidents (incident_id,session_id,learner_id,assignment_id,status,owner,response_target) VALUES ($1,$2,$3,$4,'open',$5,$5)`, [id("incident"), sessionId, learnerId, assignment.assignment_id, session.session_host_id || "Trainer Operations"]);
  }
  if (status === "resolved") await db().query(`UPDATE access_incidents SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE assignment_id=$1 AND status='open'`, [assignment.assignment_id]);
  await audit({ sourceType: "learner_assignment", sourceReference: assignment.assignment_id, actor, action: `access_outcome_${status}`, newValue: { sessionId, status } });
  return { sessionId, learnerId, status, owner: session.session_host_id || "Trainer Operations", responseTarget: session.session_host_id || "Trainer Operations" };
}

export async function getTrainerProfile(trainerId: string, includeFinance = false) {
  await ensureTrainerOperationsTables();
  const result = await db().query(`SELECT * FROM trainer_profiles WHERE trainer_id=$1`, [asText(trainerId, "trainerId", 320).toLowerCase()]);
  const profile = result.rows[0] as Record<string, unknown> | undefined;
  if (!profile) throw new Error("Trainer profile not found");
  const compliance = await db().query(`SELECT document_id, document_type, expiry_date, CASE WHEN expiry_date < CURRENT_DATE THEN 'expired' WHEN expiry_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon' ELSE 'valid' END AS status, required, file_url FROM compliance_documents WHERE trainer_id=$1 ORDER BY expiry_date`, [trainerId]);
  const safe = { trainerId: profile.trainer_id, name: profile.name, photoUrl: profile.photo_url, contactEmail: profile.contact_email, contactPhone: profile.contact_phone, paymentMethod: profile.payment_method, paymentDetails: profile.payment_details, contractStatus: profile.contract_status, onboardingStage: profile.onboarding_stage, complianceDocuments: compliance.rows } as Record<string, unknown>;
  if (includeFinance) { safe.dayRate = profile.day_rate; safe.rateCurrency = profile.rate_currency; }
  return safe;
}

export async function assertTrainerPortalAccess(trainerId: string, purpose: "portal" | "invoicing" | "assignment") {
  const profile = await getTrainerProfile(trainerId, true) as Record<string, unknown>;
  if (purpose !== "portal" && profile.contractStatus !== "signed") throw new Error("Blocked — trainer contract is not signed. Owner: Admin. Action: record the signed contract before assignment or invoicing.");
  const expired = await db().query(`SELECT document_type FROM compliance_documents WHERE trainer_id=$1 AND required=TRUE AND expiry_date < CURRENT_DATE LIMIT 1`, [trainerId]);
  if (purpose !== "portal" && expired.rows[0]) throw new Error(`Blocked — required compliance document ${expired.rows[0].document_type} is expired. Owner: Admin. Action: renew the document or record a logged override.`);
  return profile;
}

export async function updateOwnTrainerProfile(trainerId: string, update: { name?: unknown; contactEmail?: unknown; contactPhone?: unknown; photoUrl?: unknown; paymentMethod?: unknown; paymentDetails?: unknown }) {
  const restricted = ["dayRate", "rateCurrency", "contractStatus", "onboardingStage"].some((key) => Object.prototype.hasOwnProperty.call(update, key));
  if (restricted) throw new Error("Trainer rate, currency, contract status, and onboarding stage are administrator-only fields.");
  await assertTrainerPortalAccess(trainerId, "portal");
  const name = update.name === undefined ? null : asText(update.name, "name", 160);
  const contactEmail = update.contactEmail === undefined ? null : asText(update.contactEmail, "contactEmail", 320).toLowerCase();
  if (contactEmail && !isEmail(contactEmail)) throw new Error("contactEmail must be valid");
  const phone = update.contactPhone === undefined ? null : String(update.contactPhone).trim().slice(0, 80);
  const photo = update.photoUrl === undefined ? null : String(update.photoUrl).trim().slice(0, 1000);
  const method = update.paymentMethod === undefined ? null : asText(update.paymentMethod, "paymentMethod", 40);
  if (method && !["paypal", "bank_transfer", "other_platform"].includes(method)) throw new Error("paymentMethod is invalid");
  await db().query(`UPDATE trainer_profiles SET name=COALESCE($2,name),contact_email=COALESCE($3,contact_email),contact_phone=COALESCE($4,contact_phone),photo_url=COALESCE($5,photo_url),payment_method=COALESCE($6,payment_method),payment_details=COALESCE($7::jsonb,payment_details),updated_at=CURRENT_TIMESTAMP WHERE trainer_id=$1`, [trainerId, name, contactEmail, phone, photo, method, update.paymentDetails === undefined ? null : JSON.stringify(update.paymentDetails)]);
  await audit({ sourceType: "trainer_profile", sourceReference: trainerId, actor: trainerId, action: "trainer_profile_updated" });
  return getTrainerProfile(trainerId, false);
}

export async function uploadTrainerPhoto(trainerId: string, fileName: string, contentType: string, bytes: Uint8Array) {
  await assertTrainerPortalAccess(trainerId, "portal");
  if (!/\.(png|jpe?g)$/i.test(fileName) || !["image/png", "image/jpeg"].includes(contentType)) throw new Error("Profile photo must be a PNG or JPEG image.");
  if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) throw new Error("Profile photo must be between 1 byte and 2MB.");
  await db().query(`UPDATE trainer_profiles SET photo_url=$2,photo_data=$3,photo_mime=$4,updated_at=CURRENT_TIMESTAMP WHERE trainer_id=$1`, [trainerId, `/api/trainer-portal/profile/photo?trainer=${encodeURIComponent(trainerId)}`, Buffer.from(bytes), contentType]);
  await audit({ sourceType: "trainer_profile", sourceReference: trainerId, actor: trainerId, action: "trainer_photo_uploaded", newValue: { fileName } });
  return getTrainerProfile(trainerId, false);
}

export async function adminUpdateTrainerProfile(trainerId: string, update: { dayRate?: unknown; rateCurrency?: unknown; contractStatus?: unknown; onboardingStage?: unknown; name?: unknown; contactEmail?: unknown; contactPhone?: unknown }, actor = "admin") {
  await ensureTrainerOperationsTables();
  const rate = update.dayRate === undefined ? null : Number(update.dayRate);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0)) throw new Error("dayRate must be a non-negative number");
  const currency = update.rateCurrency === undefined ? null : asText(update.rateCurrency, "rateCurrency", 3).toUpperCase();
  const contract = update.contractStatus === undefined ? null : asText(update.contractStatus, "contractStatus", 30);
  const stage = update.onboardingStage === undefined ? null : asText(update.onboardingStage, "onboardingStage", 50);
  if (contract && !["pending", "signed", "withdrawn"].includes(contract)) throw new Error("contractStatus is invalid");
  if (stage && !["Observation", "20%_Delivery", "80%_Delivery", "100%_Supervised_Assessment", "Cleared"].includes(stage)) throw new Error("onboardingStage is invalid");
  await db().query(`UPDATE trainer_profiles SET day_rate=COALESCE($2,day_rate),rate_currency=COALESCE($3,rate_currency),contract_status=COALESCE($4,contract_status),onboarding_stage=COALESCE($5,onboarding_stage),name=COALESCE($6,name),contact_email=COALESCE($7,contact_email),contact_phone=COALESCE($8,contact_phone),updated_at=CURRENT_TIMESTAMP WHERE trainer_id=$1`, [trainerId, rate, currency, contract, stage, update.name === undefined ? null : asText(update.name, "name", 160), update.contactEmail === undefined ? null : asText(update.contactEmail, "contactEmail", 320), update.contactPhone === undefined ? null : String(update.contactPhone).slice(0, 80)]);
  await audit({ sourceType: "trainer_profile", sourceReference: trainerId, actor, action: "admin_trainer_profile_updated", newValue: update });
  return getTrainerProfile(trainerId, true);
}

export async function listTrainerAssignments(trainerId: string) {
  await assertTrainerPortalAccess(trainerId, "portal");
  const result = await db().query(`
    SELECT a.assignment_id,a.session_id,a.role,a.assignment_status,a.evaluation_status,a.job_reference,s.course_title,s.starts_at,s.ends_at,s.display_timezone,s.delivery_mode
    FROM learner_assignments a JOIN sessions s ON s.session_id=a.session_id
    WHERE a.trainer_id=$1 ORDER BY s.starts_at DESC`, [trainerId]);
  return result.rows;
}

export async function uploadEvaluation(input: { trainerId: string; assignmentId: string; fileName: string; contentType: string; bytes: Uint8Array }) {
  await assertTrainerPortalAccess(input.trainerId, "invoicing");
  const fileName = asText(input.fileName, "fileName", 240);
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (!["docx", "pdf"].includes(extension ?? "") || !["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(input.contentType)) throw new Error("Evaluation uploads must be PDF or DOCX files.");
  if (!input.bytes.byteLength || input.bytes.byteLength > 12 * 1024 * 1024) throw new Error("Evaluation file must be between 1 byte and 12MB.");
  const result = await db().query<{ assignment_id: string; session_id: string; role: string }>(`SELECT assignment_id,session_id,role FROM learner_assignments WHERE assignment_id=$1 AND trainer_id=$2`, [asText(input.assignmentId, "assignmentId", 180), input.trainerId]);
  const assignment = result.rows[0];
  if (!assignment || assignment.role !== "trainer") throw new Error("Evaluation may only be uploaded for the trainer's own delivered assignment.");
  const evaluationId = id("evaluation");
  await db().query(`INSERT INTO evaluations (evaluation_id,assignment_id,file_url,file_name,file_type,file_data,file_size) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [evaluationId, assignment.assignment_id, `/api/trainer-portal/evaluations/${evaluationId}/file`, fileName, extension, Buffer.from(input.bytes), input.bytes.byteLength]);
  await db().query(`UPDATE learner_assignments SET evaluation_status='submitted',updated_at=CURRENT_TIMESTAMP WHERE assignment_id=$1`, [assignment.assignment_id]);
  await audit({ sourceType: "evaluation", sourceReference: evaluationId, actor: input.trainerId, action: "evaluation_uploaded", newValue: { assignmentId: assignment.assignment_id, sessionId: assignment.session_id, fileName } });
  const invoiceSettings = await getSettings("invoicing");
  const sender = process.env.GOOGLE_WORKSPACE_ACCOUNT;
  if (sender) {
    try {
      await sendGmailMessage(sender, String(invoiceSettings.sashaEmail ?? "sasha@upskillu.org"), `Evaluation submitted — ${assignment.session_id}`, `A trainer evaluation has been submitted for session ${assignment.session_id}, assignment ${assignment.assignment_id}.`, [{ name: fileName, mime: input.contentType, data: input.bytes }]);
      await db().query(`UPDATE evaluations SET sent_to_sasha_at=CURRENT_TIMESTAMP WHERE evaluation_id=$1`, [evaluationId]);
      await audit({ sourceType: "evaluation", sourceReference: evaluationId, actor: "system", action: "evaluation_sent_to_sasha" });
    } catch (error) {
      await audit({ sourceType: "evaluation", sourceReference: evaluationId, actor: "system", action: "evaluation_sasha_delivery_failed", newValue: { reason: error instanceof Error ? error.message : "unknown" } });
    }
  }
  return { evaluationId, fileUrl: `/api/trainer-portal/evaluations/${evaluationId}/file`, evaluationStatus: "submitted" };
}

export async function createExpense(input: { trainerId: string; assignmentId: string; description: string; amount: number; currency: string; fileName: string; contentType: string; bytes: Uint8Array }) {
  await assertTrainerPortalAccess(input.trainerId, "invoicing");
  if (!input.bytes.byteLength || !input.contentType || input.bytes.byteLength > 12 * 1024 * 1024) throw new Error("A receipt upload of 12MB or smaller is required.");
  const assignment = await db().query(`SELECT assignment_id FROM learner_assignments WHERE assignment_id=$1 AND trainer_id=$2 AND role='trainer'`, [asText(input.assignmentId, "assignmentId", 180), input.trainerId]);
  if (!assignment.rows[0]) throw new Error("Expense must be linked to the trainer's own assignment.");
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error("Expense amount must be non-negative.");
  const expenseId = id("expense");
  await db().query(`INSERT INTO expenses (expense_id,assignment_id,description,amount,currency,receipt_url,receipt_name,receipt_mime,receipt_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [expenseId, input.assignmentId, asText(input.description, "description", 500), input.amount, asText(input.currency, "currency", 3).toUpperCase(), `/api/trainer-portal/expenses/${expenseId}/receipt`, asText(input.fileName, "fileName", 240), input.contentType.slice(0, 160), Buffer.from(input.bytes)]);
  await audit({ sourceType: "expense", sourceReference: expenseId, actor: input.trainerId, action: "expense_created", newValue: { assignmentId: input.assignmentId, amount: input.amount } });
  return { expenseId, status: "draft" };
}

export async function submitInvoice(input: { trainerId: string; assignmentIds: string[]; expenseIds?: string[]; periodMonth: string }) {
  const profile = await assertTrainerPortalAccess(input.trainerId, "invoicing") as Record<string, unknown>;
  const assignmentIds = [...new Set(input.assignmentIds.map((value) => asText(value, "assignmentId", 180)))];
  if (!assignmentIds.length) throw new Error("Select at least one evaluation-submitted job.");
  const periodMonth = `${asText(input.periodMonth, "periodMonth", 7)}-01`;
  if (!/^\d{4}-\d{2}-01$/.test(periodMonth)) throw new Error("periodMonth must be YYYY-MM.");
  const rate = toNumber(profile.dayRate as string | number | null);
  const currency = String(profile.rateCurrency ?? "GBP");
  const assignments = await db().query<{ assignment_id: string; job_reference: string | null; evaluation_status: string; trainer_id: string; session_fee: string | number | null; starts_at: string | Date }>(`SELECT a.assignment_id,a.job_reference,a.evaluation_status,a.trainer_id,s.session_fee,s.starts_at FROM learner_assignments a JOIN sessions s ON s.session_id=a.session_id WHERE a.assignment_id=ANY($1::text[])`, [assignmentIds]);
  if (assignments.rows.length !== assignmentIds.length || assignments.rows.some((row) => row.trainer_id !== input.trainerId)) throw new Error("Each invoice job must be the current trainer's exact assignment.");
  if (assignments.rows.some((row) => new Date(row.starts_at).toISOString().slice(0, 7) !== input.periodMonth)) throw new Error("Each selected job must fall within the invoice period month.");
  if (assignments.rows.some((row) => row.evaluation_status !== "submitted")) throw new Error("Evaluation required before invoicing.");
  const existing = await db().query(`SELECT assignment_id FROM invoice_line_items WHERE assignment_id=ANY($1::text[]) AND status <> 'rejected'`, [assignmentIds]);
  if (existing.rows[0]) throw new Error("A selected job already has a non-rejected invoice line item.");
  const expenseIds = [...new Set((input.expenseIds ?? []).map((value) => asText(value, "expenseId", 180)))];
  const expenses = expenseIds.length ? await db().query<{ expense_id: string; assignment_id: string; amount: string | number; currency: string; receipt_url: string | null }>(`SELECT expense_id,assignment_id,amount,currency,receipt_url FROM expenses WHERE expense_id=ANY($1::text[]) AND invoice_id IS NULL`, [expenseIds]) : { rows: [] };
  if (expenses.rows.length !== expenseIds.length || expenses.rows.some((expense) => !assignmentIds.includes(expense.assignment_id) || !expense.receipt_url || expense.currency !== currency)) throw new Error("Expenses must be unattached, receipted, linked to a selected job, and use the invoice currency.");
  const total = assignments.rows.length * rate + expenses.rows.reduce((sum, expense) => sum + toNumber(expense.amount), 0);
  const invoiceId = id("invoice");
  await db().query(`INSERT INTO invoices (invoice_id,trainer_id,period_month,status,total_amount,currency) VALUES ($1,$2,$3,'pending_admin_approval',$4,$5)`, [invoiceId, input.trainerId, periodMonth, total, currency]);
  for (const assignment of assignments.rows) {
    const fee = toNumber(assignment.session_fee); const margin = fee - rate;
    await db().query(`INSERT INTO invoice_line_items (line_item_id,invoice_id,assignment_id,job_reference,amount,currency,session_fee,margin,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_admin_approval')`, [id("item"), invoiceId, assignment.assignment_id, assignment.job_reference ?? assignment.assignment_id, rate, currency, fee, margin]);
  }
  if (expenseIds.length) await db().query(`UPDATE expenses SET invoice_id=$2,status='pending_admin_approval' WHERE expense_id=ANY($1::text[])`, [expenseIds, invoiceId]);
  await audit({ sourceType: "invoice", sourceReference: invoiceId, actor: input.trainerId, action: "invoice_submitted_for_admin_approval", newValue: { assignmentIds, expenseIds, total, currency } });
  return { invoiceId, status: "pending_admin_approval", totalAmount: total, currency };
}

export async function decideInvoice(invoiceId: string, decision: "approved" | "rejected", adminEmail: string, rejectedReason?: string) {
  await ensureTrainerOperationsTables();
  const result = await db().query<{ invoice_id: string; trainer_id: string; status: string; total_amount: string | number; currency: string; contact_email: string; name: string }>(`SELECT i.invoice_id,i.trainer_id,i.status,i.total_amount,i.currency,p.contact_email,p.name FROM invoices i JOIN trainer_profiles p ON p.trainer_id=i.trainer_id WHERE i.invoice_id=$1`, [asText(invoiceId, "invoiceId", 180)]);
  const invoice = result.rows[0];
  if (!invoice || invoice.status !== "pending_admin_approval") throw new Error("Only pending invoices can be decided.");
  if (decision === "rejected" && !rejectedReason?.trim()) throw new Error("A rejection reason is required.");
  const number = decision === "approved" ? `TC-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-6)}` : null;
  await db().query(`UPDATE invoices SET status=$2,approved_by=$3,approved_at=CASE WHEN $2='approved' THEN CURRENT_TIMESTAMP ELSE NULL END,rejected_reason=$4,invoice_number=$5 WHERE invoice_id=$1`, [invoice.invoice_id, decision, adminEmail, decision === "rejected" ? rejectedReason?.trim() : null, number]);
  await db().query(`UPDATE invoice_line_items SET status=$2 WHERE invoice_id=$1`, [invoice.invoice_id, decision]);
  await db().query(`UPDATE expenses SET status=$2 WHERE invoice_id=$1`, [invoice.invoice_id, decision]);
  const sender = process.env.GOOGLE_WORKSPACE_ACCOUNT;
  if (sender) await sendGmailMessage(sender, invoice.contact_email, `Invoice ${decision} — ${invoice.invoice_id}`, decision === "approved" ? `Hello ${invoice.name},\n\nYour invoice has been approved. Invoice number: ${number}.\nAmount: ${invoice.currency} ${invoice.total_amount}.\n\nTrueCosmic` : `Hello ${invoice.name},\n\nYour invoice was rejected. Reason: ${rejectedReason}.\n\nTrueCosmic`);
  await audit({ sourceType: "invoice", sourceReference: invoice.invoice_id, actor: adminEmail, action: `invoice_${decision}`, newValue: { invoiceNumber: number, rejectedReason } });
  return { invoiceId: invoice.invoice_id, status: decision, invoiceNumber: number };
}

export async function getSettings(key: "assistant_instruction" | "evaluation_reminders" | "invoicing" | "session_checkpoints") {
  await ensureTrainerOperationsTables();
  const result = await db().query<{ value: Record<string, unknown> }>(`SELECT value FROM trainer_operation_settings WHERE key=$1`, [key]);
  return result.rows[0]?.value ?? {};
}

export async function updateSettings(key: "evaluation_reminders" | "invoicing" | "session_checkpoints", value: Record<string, unknown>, actor: string) {
  await ensureTrainerOperationsTables();
  const current = await getSettings(key);
  const next = { ...current, ...value };
  if (key === "evaluation_reminders") {
    if (typeof next.enabled !== "boolean") throw new Error("enabled must be a boolean");
    for (const field of ["firstReminderHours", "repeatHours", "escalationDays", "pendingInvoiceDays"]) {
      if (next[field] !== undefined && (!Number.isFinite(Number(next[field])) || Number(next[field]) < 1 || Number(next[field]) > 365)) throw new Error(`${field} must be between 1 and 365`);
    }
  }
  if (key === "invoicing" && (!Number.isInteger(Number(next.upskilluInvoiceCutoffDay)) || Number(next.upskilluInvoiceCutoffDay) < 1 || Number(next.upskilluInvoiceCutoffDay) > 28)) throw new Error("upskilluInvoiceCutoffDay must be 1 to 28");
  if (key === "session_checkpoints") {
    if (typeof next.enabled !== "boolean") throw new Error("enabled must be a boolean");
    for (const field of ["confirmationOffsetHours", "preSessionReadinessHours", "businessDayBeforeDays", "sessionStartWindowMinutes", "postSessionOutcomeHours", "businessHoursStart", "businessHoursEnd"]) {
      if (!Number.isFinite(Number(next[field])) || Number(next[field]) < 0 || Number(next[field]) > 720) throw new Error(`${field} must be a valid non-negative checkpoint setting`);
    }
    if (Number(next.businessHoursStart) > Number(next.businessHoursEnd)) throw new Error("businessHoursStart must not be after businessHoursEnd");
  }
  await db().query(`INSERT INTO trainer_operation_settings (key,value,updated_at) VALUES ($1,$2::jsonb,CURRENT_TIMESTAMP) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=CURRENT_TIMESTAMP`, [key, JSON.stringify(next)]);
  await audit({ sourceType: "trainer_operation_settings", sourceReference: key, actor, action: "settings_updated", oldValue: current, newValue: next });
  return next;
}

export async function listAdminInvoices() {
  await ensureTrainerOperationsTables();
  const invoices = await db().query(`SELECT i.*,p.name,p.contact_email FROM invoices i JOIN trainer_profiles p ON p.trainer_id=i.trainer_id ORDER BY i.created_at DESC`);
  const lines = await db().query(`SELECT invoice_id,assignment_id,job_reference,amount,currency,session_fee,margin,status FROM invoice_line_items ORDER BY created_at`);
  const expenses = await db().query(`SELECT invoice_id,expense_id,assignment_id,description,amount,currency,receipt_url,status FROM expenses WHERE invoice_id IS NOT NULL ORDER BY created_at`);
  return invoices.rows.map((invoice) => ({ ...invoice, lineItems: lines.rows.filter((line) => line.invoice_id === invoice.invoice_id), expenses: expenses.rows.filter((expense) => expense.invoice_id === invoice.invoice_id) }));
}

export async function listAdminAttention() {
  await ensureTrainerOperationsTables();
  const reminders = await getSettings("evaluation_reminders");
  const escalationDays = Math.max(1, Number(reminders.escalationDays ?? 7));
  const pendingInvoiceDays = Math.max(1, Number(reminders.pendingInvoiceDays ?? 7));
  const [overdueEvaluations, pendingInvoices, compliance, blockedContracts] = await Promise.all([
    db().query(`SELECT a.assignment_id,s.session_id,s.course_title,p.name FROM learner_assignments a JOIN sessions s ON s.session_id=a.session_id JOIN trainer_profiles p ON p.trainer_id=a.trainer_id WHERE a.role='trainer' AND a.evaluation_status='not_submitted' AND s.ends_at < CURRENT_TIMESTAMP - ($1::text || ' days')::interval`, [String(escalationDays)]),
    db().query(`SELECT i.invoice_id,p.name,i.created_at FROM invoices i JOIN trainer_profiles p ON p.trainer_id=i.trainer_id WHERE i.status='pending_admin_approval' AND i.created_at < CURRENT_TIMESTAMP - ($1::text || ' days')::interval`, [String(pendingInvoiceDays)]),
    db().query(`SELECT p.name,c.document_type,c.expiry_date,CASE WHEN c.expiry_date < CURRENT_DATE THEN 'expired' ELSE 'expiring_soon' END AS status FROM compliance_documents c JOIN trainer_profiles p ON p.trainer_id=c.trainer_id WHERE c.required=TRUE AND c.expiry_date <= CURRENT_DATE + INTERVAL '30 days'`),
    db().query(`SELECT p.name,a.assignment_id,s.session_id FROM learner_assignments a JOIN trainer_profiles p ON p.trainer_id=a.trainer_id JOIN sessions s ON s.session_id=a.session_id WHERE p.contract_status='pending' AND s.starts_at > CURRENT_TIMESTAMP AND a.role='trainer'`),
  ]);
  return { overdueEvaluations: overdueEvaluations.rows, pendingInvoices: pendingInvoices.rows, compliance: compliance.rows, blockedContracts: blockedContracts.rows };
}

export async function buildUpskillUInvoiceDraft(month: string) {
  await ensureTrainerOperationsTables();
  const invoicing = await getSettings("invoicing");
  const cutoffDay = Math.min(28, Math.max(1, Number(invoicing.upskilluInvoiceCutoffDay ?? 15)));
  const start = `${asText(month, "month", 7)}-01`;
  if (!/^\d{4}-\d{2}-01$/.test(start)) throw new Error("month must be YYYY-MM.");
  const selected = await db().query<{ job_reference: string; session_fee: string | number; margin: string | number; currency: string; starts_at: string | Date; course_title: string }>(`
    SELECT li.job_reference,li.session_fee,li.margin,li.currency,s.starts_at,s.course_title
    FROM invoice_line_items li JOIN invoices i ON i.invoice_id=li.invoice_id JOIN learner_assignments a ON a.assignment_id=li.assignment_id JOIN sessions s ON s.session_id=a.session_id
    WHERE i.status='approved' AND s.starts_at >= $1::date AND s.starts_at < ($1::date + INTERVAL '1 month') AND EXTRACT(DAY FROM s.starts_at AT TIME ZONE s.display_timezone) <= $2
    ORDER BY s.starts_at,li.job_reference`, [start, cutoffDay]);
  const currencies = [...new Set(selected.rows.map((row) => row.currency))];
  if (currencies.length > 1) throw new Error("UpskillU invoice draft requires one currency per batch.");
  const total = selected.rows.reduce((sum, row) => sum + toNumber(row.session_fee), 0);
  const retainedMargin = selected.rows.reduce((sum, row) => sum + toNumber(row.margin), 0);
  return { periodMonth: start.slice(0, 7), cutoffDay, currency: currencies[0] ?? "GBP", totalAmount: total, retainedMargin, items: selected.rows.map((row) => ({ jobReference: row.job_reference, courseTitle: row.course_title, startsAt: row.starts_at, amount: toNumber(row.session_fee) })) };
}

async function recordCheckpoint(sessionId: string, checkpoint: "confirmation" | "pre_session_readiness" | "business_day_before" | "session_start_access" | "post_session_outcomes", subjectReference: string, status: "ready" | "waiting" | "blocked" | "escalated" | "pending", details: Record<string, unknown>) {
  await db().query(`INSERT INTO session_checkpoint_events (checkpoint_event_id,session_id,checkpoint,subject_reference,status,details) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (session_id,checkpoint,subject_reference) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,recorded_at=CURRENT_TIMESTAMP`, [id("checkpoint"), sessionId, checkpoint, subjectReference, status, JSON.stringify(details)]);
  await audit({ sourceType: "session_checkpoint", sourceReference: `${sessionId}:${checkpoint}:${subjectReference || "session"}`, actor: "system", action: `checkpoint_${checkpoint}_${status}`, newValue: details });
}

function asCheckpointStatus(readiness: ReadinessResult["readiness"]): "ready" | "waiting" | "blocked" | "escalated" {
  return readiness;
}

/**
 * Records readiness checkpoints only. It intentionally never sends communications;
 * calendar offsets are evaluated solely from `sessions.starts_at` and `display_timezone`.
 */
export async function runSessionCheckpointCycle(now = new Date()) {
  await ensureTrainerOperationsTables();
  const settings = await getSettings("session_checkpoints");
  if (!settings.enabled) return { enabled: false, processed: 0, message: "Session checkpoints are intentionally disabled until an administrator enables the new scheduler." };
  const preSessionHours = Math.max(0, Number(settings.preSessionReadinessHours ?? 72));
  const businessDayBeforeDays = Math.max(0, Number(settings.businessDayBeforeDays ?? 1));
  const startWindowMinutes = Math.max(0, Number(settings.sessionStartWindowMinutes ?? 30));
  const postSessionHours = Math.max(0, Number(settings.postSessionOutcomeHours ?? 2));
  const businessHoursStart = Math.max(0, Number(settings.businessHoursStart ?? 9));
  const businessHoursEnd = Math.min(24, Number(settings.businessHoursEnd ?? 17));
  const sessions = await db().query<SessionRecord>(`SELECT * FROM sessions WHERE status NOT IN ('cancelled','superseded') AND starts_at BETWEEN CURRENT_TIMESTAMP - INTERVAL '8 days' AND CURRENT_TIMESTAMP + INTERVAL '8 days'`);
  let processed = 0;
  for (const session of sessions.rows) {
    const start = new Date(session.starts_at); const end = new Date(session.ends_at); const diffToStartMs = start.getTime() - now.getTime();
    const readiness = await getReadiness(session.session_id, now); const status = asCheckpointStatus(readiness.readiness);
    const safeBlockers = readiness.blockers.map((blocker) => ({ code: blocker.code, owner: blocker.owner, nextAction: blocker.nextAction, assignmentId: blocker.assignmentId }));
    if (diffToStartMs <= preSessionHours * 3_600_000 && diffToStartMs >= 0 && isWithinBusinessHours(now, session.display_timezone, businessHoursStart, businessHoursEnd)) {
      await recordCheckpoint(session.session_id, "pre_session_readiness", "", status, { generatedWeekday: readiness.generatedWeekday, timezone: session.display_timezone, blockers: safeBlockers }); processed += 1;
    }
    const sessionDate = dateKey(start, session.display_timezone); const today = dateKey(now, session.display_timezone);
    if (today === businessDayBefore(sessionDate, businessDayBeforeDays) && isWithinBusinessHours(now, session.display_timezone, businessHoursStart, businessHoursEnd)) {
      for (const assignment of readiness.assignments) {
        await recordCheckpoint(session.session_id, "business_day_before", assignment.assignmentId, assignment.status.toLowerCase() as "ready" | "waiting" | "blocked" | "escalated", { assignmentId: assignment.assignmentId, owner: assignment.owner, reason: assignment.reason }); processed += 1;
      }
    }
    if (Math.abs(diffToStartMs) <= startWindowMinutes * 60_000) {
      const hostStatus = session.session_host_id && session.host_access_confirmed_at ? "ready" : "escalated";
      await recordCheckpoint(session.session_id, "session_start_access", "", hostStatus, { sessionHostId: session.session_host_id ?? null, accessConfirmationRecorded: Boolean(session.host_access_confirmed_at) }); processed += 1;
    }
    if (now.getTime() >= end.getTime() + postSessionHours * 3_600_000) {
      const outstanding = await db().query<{ assignment_id: string }>(`SELECT assignment_id FROM learner_assignments WHERE session_id=$1 AND assignment_status NOT IN ('attended','no_show','cancelled','declined')`, [session.session_id]);
      await recordCheckpoint(session.session_id, "post_session_outcomes", "", outstanding.rows.length ? "escalated" : "ready", { outstandingAssignmentIds: outstanding.rows.map((row) => row.assignment_id) }); processed += 1;
    }
  }
  return { enabled: true, processed };
}

export async function runEvaluationReminderCycle() {
  await ensureTrainerOperationsTables();
  const settings = await getSettings("evaluation_reminders");
  if (!settings.enabled) return { enabled: false, remindersSent: 0, escalated: 0, message: "Evaluation reminders are intentionally disabled until an administrator enables the new scheduler." };
  const firstReminderHours = Math.max(1, Number(settings.firstReminderHours ?? 48));
  const repeatHours = Math.max(1, Number(settings.repeatHours ?? 72));
  const escalationDays = Math.max(1, Number(settings.escalationDays ?? 7));
  const sender = process.env.GOOGLE_WORKSPACE_ACCOUNT;
  if (!sender) throw new Error("Google Workspace sender is not configured");
  const candidates = await db().query<{ evaluation_id: string; assignment_id: string; trainer_id: string; name: string; contact_email: string; session_id: string; ends_at: string | Date; reminder_count: number; last_reminder_sent_at: string | Date | null }>(`
    SELECT e.evaluation_id,e.assignment_id,a.trainer_id,p.name,p.contact_email,s.session_id,s.ends_at,e.reminder_count,e.last_reminder_sent_at
    FROM learner_assignments a JOIN sessions s ON s.session_id=a.session_id JOIN trainer_profiles p ON p.trainer_id=a.trainer_id
    LEFT JOIN evaluations e ON e.assignment_id=a.assignment_id
    WHERE a.role='trainer' AND a.evaluation_status='not_submitted' AND s.ends_at < CURRENT_TIMESTAMP - ($1::text || ' hours')::interval`, [String(firstReminderHours)]);
  let remindersSent = 0; let escalated = 0;
  for (const item of candidates.rows) {
    const ended = new Date(item.ends_at).getTime();
    if (Date.now() - ended >= escalationDays * 86_400_000) { escalated += 1; await audit({ sourceType: "learner_assignment", sourceReference: item.assignment_id, actor: "system", action: "evaluation_overdue_escalated", newValue: { sessionId: item.session_id } }); continue; }
    if (item.last_reminder_sent_at && Date.now() - new Date(item.last_reminder_sent_at).getTime() < repeatHours * 3_600_000) continue;
    await sendGmailMessage(sender, item.contact_email, `Evaluation overdue — ${item.session_id}`, `Hello ${item.name},\n\nYour evaluation for ${item.session_id} is outstanding. Please upload it through the Trainer Portal.\n\nTrueCosmic`);
    if (item.evaluation_id) await db().query(`UPDATE evaluations SET reminder_count=reminder_count+1,last_reminder_sent_at=CURRENT_TIMESTAMP WHERE evaluation_id=$1`, [item.evaluation_id]);
    remindersSent += 1;
    await audit({ sourceType: "learner_assignment", sourceReference: item.assignment_id, actor: "system", action: "evaluation_reminder_sent", newValue: { sessionId: item.session_id } });
  }
  return { enabled: true, remindersSent, escalated };
}

export function paymentDisclaimer() { return "Fees charged by PayPal, Wise, Zelle, or other transfer platforms are the trainer's responsibility. TrueCosmic pays the invoiced amount only."; }
export { htmlEscape };
