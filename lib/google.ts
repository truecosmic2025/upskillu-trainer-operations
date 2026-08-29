import { db, ensureGoogleTables } from "./db";

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

export async function decryptToken(value: string, encodedKey: string) {
  const [ivValue, encryptedValue] = value.split(".");
  if (!ivValue || !encryptedValue) throw new Error("Invalid encrypted token");
  const key = await crypto.subtle.importKey("raw", fromBase64(encodedKey), "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ivValue) }, key, fromBase64(encryptedValue));
  return new TextDecoder().decode(decrypted);
}

async function encryptToken(value: string, encodedKey: string) {
  const raw = fromBase64(encodedKey);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  const encode = (bytes: Uint8Array) => { let result = ""; for (const byte of bytes) result += String.fromCharCode(byte); return btoa(result); };
  return `${encode(iv)}.${encode(encrypted)}`;
}

export async function googleAccessToken(userEmail: string, forceRefresh = false) {
  await ensureGoogleTables();
  const result = await db().query<{access_token_encrypted:string;refresh_token_encrypted:string|null;expires_at:string}>("SELECT access_token_encrypted, refresh_token_encrypted, expires_at FROM google_connections WHERE user_email = $1", [userEmail]);
  const row = result.rows[0];
  const key = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!row || !key) throw new Error("Google is not connected");
  if (!forceRefresh && Number(row.expires_at) > Date.now() + 60_000) return decryptToken(row.access_token_encrypted, key);
  if (!row.refresh_token_encrypted || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error("Google connection must be renewed");
  const refreshToken = await decryptToken(row.refresh_token_encrypted, key);
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?:string };
    if (detail.error === "invalid_grant") throw new Error("Google authorization expired. Reconnect once to restore long-term access.");
    throw new Error("Google token refresh was temporarily unavailable. The portal will retry automatically.");
  }
  const refreshed = await response.json() as { access_token:string; expires_in:number };
  const encrypted = await encryptToken(refreshed.access_token, key);
  await db().query("UPDATE google_connections SET access_token_encrypted = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP WHERE user_email = $3", [encrypted, Date.now() + refreshed.expires_in * 1000, userEmail]);
  return refreshed.access_token;
}

export async function googleJson<T>(userEmail: string, url: string, init?: RequestInit): Promise<T> {
  let accessToken = await googleAccessToken(userEmail);
  let response = await fetch(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (response.status === 401) {
    accessToken = await googleAccessToken(userEmail, true);
    response = await fetch(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init?.headers ?? {}) } });
  }
  if (!response.ok) throw new Error(`Google request failed (${response.status})`);
  return response.json() as Promise<T>;
}
