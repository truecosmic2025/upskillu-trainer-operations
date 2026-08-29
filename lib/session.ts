const encoder = new TextEncoder();

function toBase64Url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signature(payload: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

export async function createSessionToken(email: string, secret: string) {
  const payload = toBase64Url(JSON.stringify({ email, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }));
  return `${payload}.${await signature(payload, secret)}`;
}

export async function verifySessionToken(token: string | undefined, secret: string | undefined) {
  if (!token || !secret) return null;
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied || supplied !== await signature(payload, secret)) return null;
  try {
    const decoded = payload.replaceAll("-", "+").replaceAll("_", "/");
    const data = JSON.parse(atob(decoded)) as { email?: string; expiresAt?: number };
    return data.email && data.expiresAt && data.expiresAt > Date.now() ? data.email : null;
  } catch {
    return null;
  }
}
