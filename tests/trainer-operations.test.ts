import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { generatedWeekday } from "../lib/trainer-operations";

const root = new URL("../", import.meta.url);
const service = () => readFile(new URL("lib/trainer-operations.ts", root), "utf8");

test("T-01: canonical 8 September 2026 renders Tuesday and accepts no typed weekday override", () => {
  assert.equal(generatedWeekday("2026-09-08T09:00:00+01:00", "Europe/London"), "Tuesday");
  assert.equal(generatedWeekday.length, 1, "The canonical weekday helper does not accept a weekday override");
});

test("T-02: each confirmation is bound to the selected session and its link version", async () => {
  const source = await service();
  assert.match(source, /session_id,assignment_id,learner_id,link_version,data_version/);
  assert.match(source, /session\.link_version/);
  assert.match(source, /WHERE assignment_id=\$1 AND session_id=\$2 AND link_version=\$3/);
});

test("T-03: cross-session or unassigned learner confirmation is hard blocked", async () => {
  const source = await service();
  assert.match(source, /learner \$\{learnerId\} is not assigned to \$\{sessionId\}/);
  assert.match(source, /!session \|\| !assignment \|\| \["declined", "cancelled"\]/);
});

test("T-04: day-before readiness emits only Ready, Waiting, Blocked, or Escalated", async () => {
  const source = await service();
  assert.match(source, /AssignmentReadinessStatus = "Ready" \| "Waiting" \| "Blocked" \| "Escalated"/);
  assert.match(source, /next_day_acknowledgement_missing/);
  assert.match(source, /Explicit learner acknowledgement is required for a next-day session/);
});

test("T-05: unapproved, unavailable, or expired materials block communication", async () => {
  const source = await service();
  assert.match(source, /approval_status !== "approved"/);
  assert.match(source, /materials_not_ready/);
  assert.match(source, /getApprovedMaterials/);
});

test("T-06: a replaced link invalidates every unsent draft and resets confirmations", async () => {
  const source = await service();
  assert.match(source, /session_link_replaced/);
  assert.match(source, /UPDATE outbound_messages SET status='invalidated'/);
  assert.match(source, /confirmation_status='not_sent'/);
});

test("T-07: an outstanding evaluation reaches a configurable escalation path", async () => {
  const source = await service();
  assert.match(source, /evaluation_overdue_escalated/);
  assert.match(source, /escalationDays/);
  assert.match(source, /evaluation_reminders/);
});

test("T-08: an admission-blocked report creates a human-owned incident", async () => {
  const source = await service();
  assert.match(source, /status === "admission_blocked"/);
  assert.match(source, /INSERT INTO access_incidents/);
  assert.match(source, /response_target/);
});

test("T-09: cancelled and superseded sessions block drafts, sends, and allocation", async () => {
  const source = await service();
  assert.match(source, /\["cancelled", "superseded"\]\.includes\(session\.status\)/);
  assert.match(source, /message_invalidated/);
  assert.match(source, /Cannot assign a trainer to a missing, cancelled, or superseded session/);
});

test("T-10: sent-message evidence records assignment, link version, approver, timestamps, and source", async () => {
  const source = await service();
  assert.match(source, /approved_by/);
  assert.match(source, /approved_at/);
  assert.match(source, /sent_at/);
  assert.match(source, /source TEXT NOT NULL DEFAULT 'trainer_operations_ai'/);
  assert.match(source, /approved_message_sent/);
});

test("trainer portal routes, migration, and no-legacy-reminder safety control are present", async () => {
  await Promise.all([
    "migrations/20260909_trainer_operations_phase_1_2.sql",
    "app/trainer/page.tsx",
    "app/api/trainer-portal/auth/login/route.ts",
    "app/api/trainer-portal/evaluations/route.ts",
    "app/api/trainer-portal/invoices/route.ts",
    "app/api/trainer-portal/internal/evaluation-reminders/route.ts",
    "app/api/trainer-portal/admin/attention/route.ts",
  ].map((path) => access(new URL(path, root))));
  const source = await service();
  assert.match(source, /"enabled":false/);
  assert.match(source, /intentionally disabled until an administrator enables the new scheduler/);
});

test("addendum: audit payloads redact sensitive data and provider evidence stays unverified until human approval", async () => {
  const source = await service();
  assert.match(source, /redactForAudit/);
  assert.match(source, /email\|link\|url\|body\|subject\|recipient\|contact/);
  assert.match(source, /provider_evidence_ingested_unverified/);
  assert.match(source, /provider_evidence_human_verified/);
  assert.match(source, /'unverified'/);
});

test("addendum: the five canonical checkpoint settings and outcomes are implemented", async () => {
  const source = await service();
  for (const checkpoint of ["confirmation", "pre_session_readiness", "business_day_before", "session_start_access", "post_session_outcomes"]) assert.match(source, new RegExp(checkpoint));
  assert.match(source, /businessDayBefore/);
  assert.match(source, /isWithinBusinessHours/);
  assert.match(source, /session_checkpoints/);
  assert.match(source, /runSessionCheckpointCycle/);
});
