import { NextResponse } from "next/server";
import { authenticateTrainer, registerTrainer, setTrainerCookie } from "../../../../../lib/trainer-portal-auth";
import { publicOrigin } from "../../../../../lib/public-url";

export async function POST(request: Request) {
  const form = await request.formData();
  const mode = String(form.get("mode") ?? "login");
  try {
    const email = mode === "register"
      ? await registerTrainer({ email: String(form.get("email") ?? ""), password: String(form.get("password") ?? ""), name: String(form.get("name") ?? "") })
      : await authenticateTrainer(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
    if (!email) return NextResponse.redirect(new URL("/trainer?error=credentials", publicOrigin(request)), 303);
    return setTrainerCookie(NextResponse.redirect(new URL("/trainer", publicOrigin(request)), 303), email);
  } catch (error) {
    const code = error instanceof Error && /already exists/.test(error.message) ? "exists" : "invalid";
    return NextResponse.redirect(new URL(`/trainer?error=${code}`, publicOrigin(request)), 303);
  }
}
