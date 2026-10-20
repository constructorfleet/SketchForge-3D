import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The MCP bridge is only reachable by `npx` if the package declares it as a bin
// *and* ships the directory it lives in. Either half alone publishes something
// that installs and then cannot start, which no other test would notice.
const packageRoot = join(__dirname, "..", "..", "packages", "sketchforge-client");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
};

describe("the published client package", () => {
  it("declares the MCP bridge as a binary", () => {
    expect(manifest.bin["sketchforge-mcp"]).toBe("./mcp/server.mjs");
  });

  it("ships the directory that binary lives in", () => {
    expect(manifest.files).toContain("mcp");
  });

  it("points that binary at a file node can run directly", () => {
    const entry = join(packageRoot, manifest.bin["sketchforge-mcp"]);
    const source = readFileSync(entry, "utf8");
    // Without the shebang, npm's generated shim runs it as a shell script.
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    // It must not reach outside its own package, which is all an install has.
    expect(source).not.toContain("repositoryRoot");
  });

  it("resolves the macro runner inside its own package, not a checkout", () => {
    const tools = readFileSync(join(packageRoot, "mcp", "macroTools.mjs"), "utf8");
    expect(tools).not.toContain("repositoryRoot");
    expect(tools).toContain("clientPackageRoot");
  });
});
