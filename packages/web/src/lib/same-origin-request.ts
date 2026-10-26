export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const requestUrl = new URL(request.url);
  // Vercel terminates TLS before Next.js; Cloudflare preserves the public URL.
  // Do not trust forwarded protocol headers on unknown/self-hosted runtimes.
  const protocol =
    (process.env.VERCEL === "1" ? request.headers.get("x-forwarded-proto") : null) ??
    requestUrl.protocol.slice(0, -1);
  if (protocol !== "https" && protocol !== "http") return false;
  // Behind a proxy the request URL may carry an internal host; browsers cannot
  // forge Host or X-Forwarded-Host. URL.origin also normalizes default ports.
  return [
    requestUrl.host,
    request.headers.get("host"),
    request.headers.get("x-forwarded-host"),
  ].some((host) => {
    if (!host) return false;
    try {
      return new URL(`${protocol}://${host}`).origin === originUrl.origin;
    } catch {
      return false;
    }
  });
}
