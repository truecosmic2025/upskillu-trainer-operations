import { NextResponse } from "next/server";
import { getEntitlements } from "../../../lib/db";

export async function GET() {
  const features = await getEntitlements();
  return NextResponse.json({ features });
}
