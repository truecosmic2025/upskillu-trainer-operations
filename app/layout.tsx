import type { Metadata } from "next";
import { headers } from "next/headers";
import { getBranding } from "../lib/settings";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const branding = await getBranding();
  const title = `${branding.orgName} Trainer Operations`;
  const description = `Bookings, delivery and payments in one clear, auditable ${branding.orgName} record.`;
  return { title, description, icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}, openGraph:{title,description,images:[image]}, twitter:{card:"summary_large_image",title,description,images:[image]} };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
