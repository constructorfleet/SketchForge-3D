/**
 * Bearer-token access for the REST API (upstream issue #55).
 *
 * The API can create, change, and delete projects, so unlike the dashboard's
 * own same-origin routes it is off until a token is set: a self-hoster who
 * exposes port 3000 should not find a write API there by surprise.
 */

import { operatorSettingName } from "@constructorfleet/sketchforge-engine/support/lib/operatorConfiguration";

export const API_TOKEN_ENV = operatorSettingName("SKETCHFORGE_API_TOKEN");

export function configuredApiToken() {
  const token = process.env[API_TOKEN_ENV]?.trim();
  return token ? token : null;
}

/** Constant-time compare, so a wrong token cannot be narrowed by timing it. */
function tokensMatch(presented: string, configured: string) {
  const presentedBytes = new TextEncoder().encode(presented);
  const configuredBytes = new TextEncoder().encode(configured);
  let difference = presentedBytes.byteLength ^ configuredBytes.byteLength;
  const length = Math.max(presentedBytes.byteLength, configuredBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (presentedBytes[index] ?? 0) ^ (configuredBytes[index] ?? 0);
  }
  return difference === 0;
}

export function presentedApiToken(request: Request) {
  const header = request.headers.get("authorization");
  if (header) {
    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer" && rest.length > 0) return rest.join(" ");
  }
  return request.headers.get("x-sketchforge-token")?.trim() || null;
}

export type ApiAuthorization = "ok" | "disabled" | "unauthorized";

/**
 * Whether a request may use the API.
 *
 * The configured-token check comes first deliberately. With no token this
 * answers without touching the request, which lets a static-export build
 * prerender a GET route into a file containing the "disabled" message -- an
 * odd-looking artifact, but the alternative is worse: a handler that always
 * reads the request cannot be rendered under `output: export` at all, and
 * fails the whole export build. A static site has no API either way, and what
 * it serves at those paths says exactly that.
 */
export function authorizeApiRequest(request: Request): ApiAuthorization {
  const configured = configuredApiToken();
  if (!configured) return "disabled";
  const presented = presentedApiToken(request);
  return presented && tokensMatch(presented, configured) ? "ok" : "unauthorized";
}
