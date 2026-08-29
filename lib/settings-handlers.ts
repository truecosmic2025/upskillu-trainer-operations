import { NextResponse } from "next/server";
import { currentStaffEmail } from "../app/api/integrations/google/_lib";
import { ALLOWED_LOGO_MIMES, getAdminCredential, getBranding, getStoredLogo, MAX_LOGO_BYTES, saveBranding, updateAdminCredential } from "./settings";

type StaffGetter = () => Promise<string | null>;

async function requireStaff(getter: StaffGetter) {
  const email = await getter();
  return email ? null : NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
}

export function createBrandingGetHandler(dependencies: { currentStaff?: StaffGetter } = {}) {
  return async function getBrandingHandler() {
    const blocked = await requireStaff(dependencies.currentStaff ?? currentStaffEmail);
    if (blocked) return blocked;
    return NextResponse.json({ branding: await getBranding() });
  };
}

export function createBrandingPatchHandler(dependencies: { currentStaff?: StaffGetter } = {}) {
  return async function patchBrandingHandler(request: Request) {
    const blocked = await requireStaff(dependencies.currentStaff ?? currentStaffEmail);
    if (blocked) return blocked;
    try {
      const form = await request.formData();
      const orgName = String(form.get("orgName") ?? "");
      const value = form.get("logo");
      let logo: { data: Buffer; mime: string } | undefined;
      if (value instanceof File && value.size > 0) {
        if (!ALLOWED_LOGO_MIMES.has(value.type)) return NextResponse.json({ error: "Logo must be a PNG, JPEG, or SVG image" }, { status: 400 });
        if (value.size > MAX_LOGO_BYTES) return NextResponse.json({ error: "Logo files must be 2MB or smaller" }, { status: 400 });
        logo = { data: Buffer.from(await value.arrayBuffer()), mime: value.type };
      } else if (value !== null && typeof value !== "string") {
        return NextResponse.json({ error: "Logo upload was invalid" }, { status: 400 });
      }
      return NextResponse.json({ branding: await saveBranding({ orgName, logo }) });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save branding" }, { status: 400 });
    }
  };
}

export function createLogoHandler() {
  return async function logoHandler() {
    try {
      const logo = await getStoredLogo();
      if (!logo) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(logo.data), {
        headers: {
          "Content-Type": logo.mime,
          "Cache-Control": "private, max-age=300",
          "Content-Security-Policy": "sandbox",
          "Content-Length": String(logo.data.byteLength),
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

export function createAdminGetHandler(dependencies: { currentStaff?: StaffGetter } = {}) {
  return async function getAdminHandler() {
    const blocked = await requireStaff(dependencies.currentStaff ?? currentStaffEmail);
    if (blocked) return blocked;
    const credential = await getAdminCredential();
    return NextResponse.json({ email: credential?.email ?? process.env.ADMIN_EMAIL ?? "admin@truecosmic.com", configuredInDatabase: Boolean(credential) });
  };
}

export function createAdminPatchHandler(dependencies: { currentStaff?: StaffGetter } = {}) {
  return async function patchAdminHandler(request: Request) {
    const blocked = await requireStaff(dependencies.currentStaff ?? currentStaffEmail);
    if (blocked) return blocked;
    try {
      const body = await request.json() as { email?: unknown; currentPassword?: unknown; newPassword?: unknown };
      if (typeof body.currentPassword !== "string" || !body.currentPassword) return NextResponse.json({ error: "Current password is required" }, { status: 400 });
      if (body.email !== undefined && typeof body.email !== "string") return NextResponse.json({ error: "Email must be text" }, { status: 400 });
      if (body.newPassword !== undefined && typeof body.newPassword !== "string") return NextResponse.json({ error: "New password must be text" }, { status: 400 });
      const admin = await updateAdminCredential({ email: body.email, currentPassword: body.currentPassword, newPassword: body.newPassword });
      return NextResponse.json({ admin });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update administrator credentials" }, { status: 400 });
    }
  };
}
