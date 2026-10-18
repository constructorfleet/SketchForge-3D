/**
 * Shared checks for SketchForge's own API routes.
 *
 * Deliberately not used by the shared-projects route, which carries its own
 * copy: that file is byte-identical to upstream's and worth keeping that way.
 */

/**
 * Whether a request came from the page itself rather than another site.
 *
 * A browser sends `Origin` on cross-site writes, so a mismatched one is a
 * forgery attempt. A missing one is a non-browser client -- curl, a script --
 * which this does not try to judge; token-authenticated routes decide that.
 */
export function sameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host") || requestUrl.host;
    const protocol = forwardedProtocol || requestUrl.protocol.replace(/:$/, "");
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}
