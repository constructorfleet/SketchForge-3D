/**
 * Bearer-token access for the REST API (upstream issue #55).
 *
 * The API can create, change, and delete projects, so unlike the dashboard's
 * own same-origin routes it is off until a token is set: a self-hoster who
 * exposes port 3000 should not find a write API there by surprise.
 */

export const API_TOKEN_ENV = "SKETCHFORGE_API_TOKEN";

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

export function authorizeApiRequest(request: Request): ApiAuthorization {
  const configured = configuredApiToken();
  if (!configured) return "disabled";
  const presented = presentedApiToken(request);
  return presented && tokensMatch(presented, configured) ? "ok" : "unauthorized";
}
