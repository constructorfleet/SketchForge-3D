/**
 * Serves MCP over Streamable HTTP, gated like `/api/v1`.
 * Exports POST only: Next answers 405 for GET, which the transport requires without SSE.
 */

import { apiContext } from "@/lib/apiV1";
import { createHostedMcpHandler } from "../../../../../packages/sketchforge-client/mcp/hosted.mjs";
// Bundled: a standalone build ships no manifest for the MCP code to read.
import clientManifest from "../../../../../packages/sketchforge-client/package.json";

export const runtime = "nodejs";
export const revalidate = false;

const handleMcpRequest = createHostedMcpHandler({ version: clientManifest.version });

export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  return handleMcpRequest(request);
}
