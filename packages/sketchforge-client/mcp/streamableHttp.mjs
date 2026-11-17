/**
 * Serves MCP Streamable HTTP statelessly: one JSON body per POST, no SSE, no session.
 * Authorize requests before calling the handler.
 */

import { SUPPORTED_PROTOCOL_VERSIONS, rpcError } from "./protocol.mjs";

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "Content-Type": "application/json" } });
}

function refusal(status, code, message) {
  return json(rpcError(null, code, message), status);
}

/** Detects cross-site browser requests by comparing Origin with Host. */
function foreignOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const hosts = [request.headers.get("x-forwarded-host"), request.headers.get("host")]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  // Runtimes that drop Host leave only the URL to compare.
  if (!hosts.length) hosts.push(new URL(request.url).host.toLowerCase());
  try {
    return !hosts.includes(new URL(origin).host.toLowerCase());
  } catch {
    return true;
  }
}

function accepts(request, mediaType) {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  const [type] = mediaType.split("/");
  return accept.split(",").some((entry) => {
    const offered = entry.split(";")[0].trim().toLowerCase();
    return offered === mediaType || offered === "*/*" || offered === `${type}/*`;
  });
}

/** Reads at most `maxBytes`, or resolves null once the body exceeds it. */
async function boundedBody(request, maxBytes) {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") return false;
  return typeof value.method === "string" || "result" in value || "error" in value;
}

/** Builds a `(Request) => Promise<Response>` handler for POSTed JSON-RPC messages. */
export function createStreamableHttpHandler({ dispatch, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
  return async function handle(request) {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
    }
    if (foreignOrigin(request)) return refusal(403, -32600, "Origin is not this server.");
    const version = request.headers.get("mcp-protocol-version");
    if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return refusal(400, -32600, `Unsupported MCP-Protocol-Version: ${version}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`);
    }
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
      return refusal(415, -32600, "Content-Type must be application/json.");
    }
    if (!accepts(request, "application/json")) return refusal(406, -32600, "Accept must include application/json.");

    const bytes = await boundedBody(request, maxBodyBytes);
    if (!bytes) return refusal(413, -32600, `Request body exceeds ${maxBodyBytes} bytes.`);
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return refusal(400, -32700, "Parse error");
    }

    const batch = Array.isArray(payload);
    const messages = batch ? payload : [payload];
    if (!messages.length || !messages.every(isMessage)) return refusal(400, -32600, "Invalid Request");

    // In order: batched writes to one project would contend for its lock.
    const responses = [];
    for (const message of messages) {
      const response = typeof message.method === "string" ? await dispatch(message) : undefined;
      if (response) responses.push(response);
    }
    if (!responses.length) return new Response(null, { status: 202, headers: NO_STORE });
    return json(batch ? responses : responses[0]);
  };
}
