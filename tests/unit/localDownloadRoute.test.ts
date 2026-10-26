import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/local-download/route";

let root = "";
let previousEnabled: string | undefined;
let previousRoot: string | undefined;

function request(folder: string) {
  return new Request("http://localhost/api/local-download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "safe", filename: "test.txt", folder }),
  });
}

describe("local download route", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-local-download-"));
    previousEnabled = process.env.SKETCHFORGE_DESKTOP;
    previousRoot = process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT;
    delete process.env.SKETCHFORGE_DESKTOP;
    delete process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT;
  });

  afterEach(async () => {
    if (previousEnabled === undefined) delete process.env.SKETCHFORGE_DESKTOP;
    else process.env.SKETCHFORGE_DESKTOP = previousEnabled;
    if (previousRoot === undefined) delete process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT;
    else process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is disabled unless explicitly enabled with a configured root", async () => {
    const response = await POST(request(root));
    expect(response.status).toBe(403);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects folders outside the configured root", async () => {
    process.env.SKETCHFORGE_DESKTOP = "1";
    process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT = root;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-outside-"));
    try {
      const response = await POST(request(outside));
      expect(response.status).toBe(400);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an oversized JSON body before parsing it", async () => {
    process.env.SKETCHFORGE_DESKTOP = "1";
    process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT = root;
    const response = await POST(new Request("http://localhost/api/local-download", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(26 * 1024 * 1024 + 1),
      },
      body: "{}",
    }));

    expect(response.status).toBe(413);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects an oversized streamed JSON body when its length is not declared", async () => {
    process.env.SKETCHFORGE_DESKTOP = "1";
    process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT = root;
    const response = await POST(new Request("http://localhost/api/local-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(26 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
      // Node's Request implementation requires duplex when given a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" }),);

    expect(response.status).toBe(413);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects a folder whose existing parent symlink escapes the configured root", async () => {
    process.env.SKETCHFORGE_DESKTOP = "1";
    process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT = root;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-symlink-outside-"));
    await fs.symlink(outside, path.join(root, "escape"));
    try {
      const response = await POST(request(path.join(root, "escape", "nested")));
      expect(response.status).toBe(400);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("writes to a folder within the configured root when enabled", async () => {
    process.env.SKETCHFORGE_DESKTOP = "1";
    process.env.SKETCHFORGE_LOCAL_DOWNLOAD_ROOT = root;
    const destination = path.join(root, "exports");
    const response = await POST(request(destination));
    expect(response.status).toBe(200);
    expect(await fs.readFile(path.join(destination, "test.txt"), "utf8")).toBe("safe");
  });
});
