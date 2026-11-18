import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The version this bridge reports is the package's, read at startup rather than
 * written here: it ships inside `@constructorfleet/sketchforge3d`, whose version
 * tracks the app's, and a client that logs a hand-written number would say
 * something untrue after the first release.
 */
const packageVersion = (() => {
  try {
    const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function textContent(value) {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

export function toolResult(value) {
  if (value?.dataUrl?.startsWith?.("data:image/png;base64,")) {
    return {
      content: [
        textContent({ face: value.face, ...(value.view === undefined ? {} : { view: value.view }), bytesApprox: value.bytesApprox }),
        {
          type: "image",
          data: value.dataUrl.slice("data:image/png;base64,".length),
          mimeType: "image/png",
        },
      ],
    };
  }
  return { content: [textContent(value)] };
}

/** Lists newest first; initialize falls back to the first entry. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Builds the JSON-RPC handler shared by every transport; resolves undefined for notifications.
 * Pass `version` when the package manifest is not on disk.
 */
export function createDispatcher({ tools, callTool, version = packageVersion }) {
  return async function dispatch(message) {
    if (!message || typeof message !== "object") return undefined;
    const { id, method, params } = message;
    if (id === undefined || id === null) return undefined;
    try {
      if (method === "initialize") {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "sketchforge-mcp", version },
        });
      }
      if (method === "ping") return rpcResult(id, {});
      if (method === "tools/list") return rpcResult(id, { tools });
      if (method === "tools/call") {
        const name = params?.name;
        if (typeof name !== "string") return rpcError(id, -32602, "Expected tool name");
        return rpcResult(id, toolResult(await callTool(name, params?.arguments || {})));
      }
      if (method === "resources/list") return rpcResult(id, { resources: [] });
      return rpcError(id, -32601, `Unknown method: ${method}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (method === "tools/call") return rpcResult(id, { isError: true, content: [textContent(text)] });
      return rpcError(id, -32000, text);
    }
  };
}
