import { cookies } from "next/headers";
import { verifySessionToken } from "../../../../lib/session";
import { publicOrigin } from "../../../../lib/public-url";

export const googleScopes = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.file",
];

export function config() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    encryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY,
    googleAccount: process.env.GOOGLE_WORKSPACE_ACCOUNT ?? "admin@truecosmic.com",
  };
}

export async function currentStaffEmail() {
  const jar = await cookies();
  return verifySessionToken(jar.get("trainer_ops_session")?.value, process.env.SESSION_SECRET);
}

export function callbackUrl(request: Request) {
  return `${publicOrigin(request)}/api/integrations/google/callback`;
}

export async function encryptToken(value: string, encodedKey: string) {
  const raw = Uint8Array.from(atob(encodedKey), c => c.charCodeAt(0));
  if (raw.byteLength !== 32) throw new Error("Token encryption key must decode to 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`;
}

function toBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
