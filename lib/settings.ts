import bcrypt from "bcryptjs";
import { db, ensureBookingTables } from "./db";

const ACCOUNT_ID = "default";
export const DEFAULT_ORG_NAME = "TrueCosmic";
export const DEFAULT_BRAND_MARK = "TC";
export const ALLOWED_LOGO_MIMES = new Set(["image/png", "image/jpeg", "image/svg+xml"]);
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export type Branding = { orgName: string; hasLogo: boolean; updatedAt: string | Date | null };
type SettingsRow = { org_name: string | null; logo_data: Buffer | null; logo_mime: string | null; updated_at: string | Date | null };
type CredentialRow = { email: string; password_hash: string; updated_at: string | Date };

export async function getBranding(): Promise<Branding> {
  try {
    await ensureBookingTables();
    const result = await db().query<SettingsRow>(`SELECT org_name, logo_data, logo_mime, updated_at FROM account_settings WHERE account_id=$1`, [ACCOUNT_ID]);
    const row = result.rows[0];
    return { orgName: row?.org_name?.trim() || DEFAULT_ORG_NAME, hasLogo: Boolean(row?.logo_data && row.logo_mime), updatedAt: row?.updated_at ?? null };
  } catch {
    return { orgName: DEFAULT_ORG_NAME, hasLogo: false, updatedAt: null };
  }
}

export async function getStoredLogo() {
  await ensureBookingTables();
  const result = await db().query<Pick<SettingsRow, "logo_data" | "logo_mime">>(`SELECT logo_data, logo_mime FROM account_settings WHERE account_id=$1`, [ACCOUNT_ID]);
  const row = result.rows[0];
  if (!row?.logo_data || !row.logo_mime) return null;
  return { data: row.logo_data, mime: row.logo_mime };
}

export async function saveBranding(input: { orgName?: string; logo?: { data: Buffer; mime: string } | null }) {
  const orgName = input.orgName?.trim().slice(0, 120) || null;
  await ensureBookingTables();
  await db().query(
    `INSERT INTO account_settings (account_id, org_name, logo_data, logo_mime, updated_at)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
     ON CONFLICT (account_id) DO UPDATE SET
       org_name=EXCLUDED.org_name,
       logo_data=COALESCE(EXCLUDED.logo_data, account_settings.logo_data),
       logo_mime=COALESCE(EXCLUDED.logo_mime, account_settings.logo_mime),
       updated_at=CURRENT_TIMESTAMP`,
    [ACCOUNT_ID, orgName, input.logo?.data ?? null, input.logo?.mime ?? null],
  );
  return getBranding();
}

export async function getAdminCredential() {
  await ensureBookingTables();
  const result = await db().query<CredentialRow>(`SELECT email, password_hash, updated_at FROM admin_credentials WHERE account_id=$1`, [ACCOUNT_ID]);
  return result.rows[0] ?? null;
}

export async function verifyCurrentAdminPassword(password: string) {
  const credential = await getAdminCredential();
  if (credential) return bcrypt.compare(password, credential.password_hash);
  const envPassword = process.env.ADMIN_PASSWORD;
  return Boolean(envPassword && password === envPassword);
}

export async function authenticateAdmin(password: string) {
  const credential = await getAdminCredential();
  if (credential) return (await bcrypt.compare(password, credential.password_hash)) ? credential.email : null;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword || password !== envPassword) return null;
  return process.env.ADMIN_EMAIL ?? "admin@truecosmic.com";
}

export async function updateAdminCredential(input: { email?: string; currentPassword: string; newPassword?: string }) {
  if (!await verifyCurrentAdminPassword(input.currentPassword)) throw new Error("Current password was not recognised");
  const existing = await getAdminCredential();
  const email = input.email?.trim().toLowerCase() || existing?.email || process.env.ADMIN_EMAIL || "admin@truecosmic.com";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid administrator email address");
  if (input.newPassword !== undefined && input.newPassword.length > 0 && input.newPassword.length < 10) {
    throw new Error("New passwords must contain at least 10 characters");
  }
  const passwordHash = input.newPassword?.length
    ? await bcrypt.hash(input.newPassword, 12)
    : existing?.password_hash ?? await bcrypt.hash(input.currentPassword, 12);
  await ensureBookingTables();
  await db().query(
    `INSERT INTO admin_credentials (account_id, email, password_hash, updated_at)
     VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
     ON CONFLICT (account_id) DO UPDATE SET email=EXCLUDED.email, password_hash=EXCLUDED.password_hash, updated_at=CURRENT_TIMESTAMP`,
    [ACCOUNT_ID, email, passwordHash],
  );
  return { email };
}
