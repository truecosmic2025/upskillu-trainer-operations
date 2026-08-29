import assert from "node:assert/strict";
import test from "node:test";
import { createBrandingGetHandler, createBrandingPatchHandler, createLogoHandler, createAdminPatchHandler } from "../lib/settings-handlers";
import { POST as loginPost } from "../app/api/auth/login/route";
import { proxy } from "../proxy";
import { NextRequest } from "next/server";
import { authenticateAdmin, DEFAULT_ORG_NAME, getBranding } from "../lib/settings";
import { db, ensureBookingTables } from "../lib/db";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const dbTest = hasDatabase ? test : test.skip;
const staff = async () => "admin@truecosmic.com";

async function clearSettings() {
  await db().query(`DELETE FROM admin_credentials WHERE account_id='default'`);
  await db().query(`DELETE FROM account_settings WHERE account_id='default'`);
  await db().query(`DELETE FROM account_billing WHERE account_id='default'`);
}

function brandingRequest(orgName: string, logo?: File) {
  const form = new FormData();
  form.set("orgName", orgName);
  if (logo) form.set("logo", logo);
  return new Request("http://localhost/api/settings/branding", { method: "PATCH", body: form });
}

dbTest("branding persists with a logo, the public logo route returns its content type, and the fallback is TrueCosmic", async () => {
  await ensureBookingTables();
  await clearSettings();
  try {
    assert.deepEqual(await getBranding(), { orgName: DEFAULT_ORG_NAME, hasLogo: false, updatedAt: null });
    const patch = createBrandingPatchHandler({ currentStaff: staff });
    const response = await patch(brandingRequest("UpskillU", new File([new Uint8Array([137,80,78,71])], "logo.png", { type: "image/png" })));
    assert.equal(response.status, 200);
    const body = await response.json() as { branding: { orgName: string; hasLogo: boolean; updatedAt: string | null } };
    assert.deepEqual(body.branding, { orgName: "UpskillU", hasLogo: true, updatedAt: body.branding.updatedAt });
    const logo = await createLogoHandler()();
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await logo.arrayBuffer())], [137,80,78,71]);
    const get = await createBrandingGetHandler({ currentStaff: staff })();
    assert.equal(get.status, 200);
  } finally { await clearSettings(); }
});

dbTest("branding rejects unsupported and oversized logo uploads", async () => {
  await ensureBookingTables();
  await clearSettings();
  try {
    const patch = createBrandingPatchHandler({ currentStaff: staff });
    const wrongType = await patch(brandingRequest("UpskillU", new File(["not-an-image"], "logo.gif", { type: "image/gif" })));
    assert.equal(wrongType.status, 400);
    const oversize = await patch(brandingRequest("UpskillU", new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })));
    assert.equal(oversize.status, 400);
    assert.equal((await getBranding()).hasLogo, false);
  } finally { await clearSettings(); }
});

dbTest("administrator credentials require the current password, use bcrypt thereafter, and preserve the environment fallback before migration", async () => {
  await ensureBookingTables();
  await clearSettings();
  const previousEmail = process.env.ADMIN_EMAIL;
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_EMAIL = "legacy@example.test";
  process.env.ADMIN_PASSWORD = "legacy-pass-123";
  try {
    assert.equal(await authenticateAdmin("legacy-pass-123"), "legacy@example.test");
    const patch = createAdminPatchHandler({ currentStaff: staff });
    const rejected = await patch(new Request("http://localhost/api/settings/admin", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@upskillu.test", currentPassword: "wrong-password", newPassword: "new-password-456" }) }));
    assert.equal(rejected.status, 400);
    const updated = await patch(new Request("http://localhost/api/settings/admin", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@upskillu.test", currentPassword: "legacy-pass-123", newPassword: "new-password-456" }) }));
    assert.equal(updated.status, 200);
    assert.equal(await authenticateAdmin("legacy-pass-123"), null);
    assert.equal(await authenticateAdmin("new-password-456"), "owner@upskillu.test");
  } finally {
    if (previousEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousPassword;
    await clearSettings();
  }
});

dbTest("login route keeps the environment fallback then accepts the changed database password", async () => {
  await ensureBookingTables();
  await clearSettings();
  const previousEmail = process.env.ADMIN_EMAIL;
  const previousPassword = process.env.ADMIN_PASSWORD;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.ADMIN_EMAIL = "legacy@example.test";
  process.env.ADMIN_PASSWORD = "legacy-pass-123";
  process.env.SESSION_SECRET = "settings-test-session-secret";
  const requestFor = (password: string) => { const form = new FormData(); form.set("password", password); return new Request("http://localhost/api/auth/login", { method: "POST", headers: { host: "localhost:3000" }, body: form }); };
  try {
    const legacyLogin = await loginPost(requestFor("legacy-pass-123"));
    assert.equal(legacyLogin.status, 303);
    const update = await createAdminPatchHandler({ currentStaff: staff })(new Request("http://localhost/api/settings/admin", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "legacy-pass-123", newPassword: "new-password-456" }) }));
    assert.equal(update.status, 200);
    const oldPasswordLogin = await loginPost(requestFor("legacy-pass-123"));
    assert.equal(oldPasswordLogin.headers.get("location")?.includes("error=1"), true);
    const newPasswordLogin = await loginPost(requestFor("new-password-456"));
    assert.equal(newPasswordLogin.status, 303);
    assert.match(newPasswordLogin.headers.get("set-cookie") ?? "", /trainer_ops_session/);
  } finally {
    if (previousEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousPassword;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
    await clearSettings();
  }
});

test("the session proxy permits only the public settings logo route without a staff cookie", async () => {
  const response = await proxy(new NextRequest("http://localhost/api/settings/logo"));
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

dbTest("Settings mutations remain reachable when billing is past due", async () => {
  await ensureBookingTables();
  await clearSettings();
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "legacy-pass-123";
  try {
    await db().query(`INSERT INTO account_billing (account_id, status) VALUES ('default','past_due')`);
    const branding = await createBrandingPatchHandler({ currentStaff: staff })(brandingRequest("Locked but self-service"));
    assert.equal(branding.status, 200);
    const credentials = await createAdminPatchHandler({ currentStaff: staff })(new Request("http://localhost/api/settings/admin", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "legacy-pass-123", newPassword: "recovery-pass-456" }) }));
    assert.equal(credentials.status, 200);
  } finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousPassword;
    await clearSettings();
  }
});
