/**
 * Helpers for API routes that act on the machine running the server (updating
 * its checkout, writing to its filesystem) and so must not be reachable by
 * other machines.
 *
 * Why there is no peer-address check here: an app-router route handler
 * receives a web `Request`, which carries no socket. Next 15 removed
 * `NextRequest.ip`, and its node server fills `x-forwarded-for` from the
 * socket only when the client did not send one (`??=` in `base-server`), so
 * the header a handler sees is whatever the client chose to send. The project
 * runs under `next start` / the standalone `server.js` with no custom server
 * in front, so there is no trusted layer that could stamp the real peer. The
 * one value that might look like a peer check, `new URL(request.url).hostname`,
 * is built from the Host header and is just as client-controlled.
 *
 * So the authority for a local-only action is server-side configuration that
 * a remote client cannot forge: an explicit operator opt-in
 * (`localOnlyOptIn`) or a shared secret the caller must present. The
 * Host-based test below still decides which mode to present, for example
 * offering the local updater to someone browsing their own dev server, but it
 * must never be the only gate in front of a privileged action.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the request is addressed to a loopback host name. The answer comes
 * from the Host header, which the client controls: use it for routing
 * decisions only, never as an authorization check.
 */
export function addressedToLoopbackHost(request: Request) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(request.url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Whether the operator explicitly opted in to a local-only capability through
 * the environment variable `name`. Only `1` and `true` (any case) count, so an
 * empty or mistyped value leaves the capability off.
 */
export function localOnlyOptIn(name: string, env: Record<string, string | undefined> = process.env) {
  const value = env[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}
