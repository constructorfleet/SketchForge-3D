import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/sketchforge-mcp/route";

// The editor heartbeats into this route from the page it is served on, and the
// MCP bridge reads the result. A rejected heartbeat is invisible in the UI: the
// tab just never shows up in `sketchforge_list_editors`.
function heartbeat(url: string, headers: Record<string, string> = {}) {
  return POST(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      type: "heartbeat",
      editor: { editorId: `editor-${Math.random()}`, editorNumber: 12345, projectName: "Probe", shapeCount: 0, url },
    }),
  }));
}

describe("the MCP route's local-origin check", () => {
  it("accepts a tab served from 127.0.0.1 even though Next reports the url as localhost", async () => {
    // The case that was broken: Next normalizes `request.url` to `localhost`,
    // so an origin of 127.0.0.1 never matched it as a string.
    const response = await heartbeat("http://localhost:3000/api/sketchforge-mcp", {
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(200);
  });

  it("accepts a tab served from localhost", async () => {
    const response = await heartbeat("http://localhost:3000/api/sketchforge-mcp", {
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(200);
  });

  it("accepts a request that sends no origin at all", async () => {
    expect((await heartbeat("http://127.0.0.1:3000/api/sketchforge-mcp")).status).toBe(200);
  });

  it("refuses an origin that is not a local host", async () => {
    const response = await heartbeat("http://localhost:3000/api/sketchforge-mcp", {
      origin: "http://evil.example.com",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a local origin on a different port", async () => {
    // Another app on the same machine is not this app.
    const response = await heartbeat("http://localhost:3000/api/sketchforge-mcp", {
      origin: "http://localhost:4000",
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a cross-site fetch even from a local origin", async () => {
    const response = await heartbeat("http://localhost:3000/api/sketchforge-mcp", {
      origin: "http://localhost:3000",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
  });

  it("lists an editor that heartbeated from 127.0.0.1", async () => {
    await heartbeat("http://localhost:3000/api/sketchforge-mcp", {
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    });
    const listed = await GET(new Request("http://localhost:3000/api/sketchforge-mcp", {
      headers: { origin: "http://127.0.0.1:3000" },
    }));
    expect(listed.status).toBe(200);
    const body = await listed.json() as { editors: Array<{ editorNumber: number }> };
    expect(body.editors.some((editor) => editor.editorNumber === 12345)).toBe(true);
  });
});
