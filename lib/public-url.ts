export function publicOrigin(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host") ?? new URL(request.url).host;
  const protocol = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
