import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const requiredRoutes = [
  "app/api/clients/route.ts",
  "app/api/bookings/route.ts",
  "app/api/bookings/allocations/route.ts",
  "app/api/bookings/invites/route.ts",
  "app/api/bookings/pipeline/route.ts",
  "app/api/trainers/route.ts",
  "app/api/speakers/route.ts",
  "app/api/digest/route.ts",
  "app/api/entitlements/route.ts",
  "app/api/operations/attention/route.ts",
];

test("includes each booking and delivery operations API route", async () => {
  await Promise.all(requiredRoutes.map((route) => access(new URL(route, root))));
});

test("defines the complete PostgreSQL delivery-operations data model", async () => {
  const db = await readFile(new URL("lib/db.ts", root), "utf8");
  for (const table of [
    "clients",
    "bookings",
    "trainers",
    "trainer_availability",
    "booking_allocations",
    "speakers",
    "booking_speakers",
    "delivery_invites",
    "post_session_pipeline",
    "account_entitlements",
    "digest_drafts",
  ]) {
    assert.match(db, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(db, /'to_be_confirmed','confirmed','cancelled'/);
  assert.match(db, /attendance_late BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(db, /features JSONB NOT NULL DEFAULT '\{"bookings":true,"guestSpeakers":true,"clients":true,"operationsAgent":true\}'::jsonb/);
});

test("enforces the booking confirmation, held-date, and safety rules", async () => {
  const [booking, digest, invites, page] = await Promise.all([
    readFile(new URL("app/api/bookings/route.ts", root), "utf8"),
    readFile(new URL("app/api/digest/route.ts", root), "utf8"),
    readFile(new URL("app/api/bookings/invites/route.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.match(booking, /archivedDates/);
  assert.match(booking, /confirmationReady/);
  assert.match(booking, /Chosen date must be one of the held TBC dates/);
  assert.match(digest, /status='approved'/);
  assert.match(digest, /Please review before sharing/);
  assert.doesNotMatch(digest, /gmail\.googleapis\.com|\/send/);
  assert.match(invites, /forwarded_at=CASE WHEN/);
  assert.match(page, /No message is ever sent automatically/);
  assert.match(page, /LEAD GETS FIRST PICK/);
});

test("implements late-attendance calculation and dashboard attention cards", async () => {
  const [pipeline, attention] = await Promise.all([
    readFile(new URL("app/api/bookings/pipeline/route.ts", root), "utf8"),
    readFile(new URL("app/api/operations/attention/route.ts", root), "utf8"),
  ]);
  assert.match(pipeline, /24 \* 60 \* 60 \* 1000/);
  assert.match(pipeline, /attendance_received_at=CURRENT_TIMESTAMP, attendance_late=\$2/);
  assert.match(attention, /Attendance sheet late/);
  assert.match(attention, /Client invite not forwarded/);
});
